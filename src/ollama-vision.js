import { request, Agent } from "node:http";
import { validateVisionControls } from "./config.js";
import { DEFAULT_VLM_SYSTEM_PROMPT } from "./prompt-store.js";

const MAX_VISION_RESPONSE_BYTES = 16_384;

// Explicit numeric loopback and a dedicated Agent bypass ambient proxy/dispatcher
// and http.globalAgent state. Each request owns and releases its sockets.
function nativeLoopbackFetch(url, { body, signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const parsed = new URL(url);
    const hostname = parsed.hostname === "[::1]" ? "::1" : "127.0.0.1";
    const agent = new Agent({ keepAlive: false, proxyEnv: {} });
    let response;
    const cleanup = () => { signal.removeEventListener("abort", abort); agent.destroy(); };
    const abort = () => {
      response?.destroy(signal.reason);
      req.destroy(signal.reason);
    };
    const req = request({
      protocol: "http:", hostname, port: parsed.port || 80,
      path: "/api/chat", method: "POST", agent,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, res => {
      response = res;
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume(); req.destroy(); cleanup();
        reject(new Error("local vision refused redirect")); return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume(); req.destroy(); cleanup();
        reject(new Error(`local vision request failed with HTTP ${res.statusCode}`)); return;
      }
      // Preserve the explicit fake-fetch response interface without using fetch.
      const iterator = res[Symbol.asyncIterator]();
      resolve({
        ok: true, status: res.statusCode,
        headers: { get: name => res.headers[name.toLowerCase()] ?? null },
        body: {
          cancel: async () => { res.destroy(); cleanup(); },
          getReader: () => ({
            read: () => iterator.next(),
            cancel: async () => { res.destroy(); cleanup(); },
            releaseLock: cleanup,
          }),
        },
      });
    });
    req.on("error", error => { cleanup(); reject(error); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else req.end(body);
  });
}

async function readBoundedJson(response) {
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    await response.body?.cancel?.();
    throw new Error("local vision returned an invalid content type");
  }
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VISION_RESPONSE_BYTES) {
    await response.body?.cancel?.();
    throw new Error("local vision response exceeded the byte limit");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("local vision returned an invalid streaming response");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_VISION_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("local vision response exceeded the byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw new Error("local vision returned invalid JSON");
  }
}

function assertLoopback(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
    throw new Error("local vision endpoint must use an HTTP loopback address");
  }
  return parsed.origin;
}

export class OllamaVision {
  #baseUrl;
  #fetch;
  #model;
  #timeoutMs;
  #options;
  #keepAlive;

  constructor({
    baseUrl = "http://127.0.0.1:11434",
    model = "qwen3.8:27b",
    // Explicit dependency injection is a test seam, never a config/environment option.
    fetchImpl = nativeLoopbackFetch,
    timeoutMs = 60_000,
    num_ctx,
    num_predict = 300,
    keep_alive = "2m",
  } = {}) {
    validateVisionControls({baseUrl, model, num_ctx, num_predict, keep_alive});
    this.#baseUrl = assertLoopback(baseUrl);
    this.#model = model;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#options = { temperature: 0.2, num_predict, ...(num_ctx === undefined ? {} : { num_ctx }) };
    this.#keepAlive = keep_alive;
  }

  async describe({
    imageBase64,
    mime,
    question,
    signal,
    systemPrompt = DEFAULT_VLM_SYSTEM_PROMPT,
  }) {
    if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
      throw new Error("local vision requires an in-memory image");
    }
    if (!new Set(["image/jpeg", "image/png"]).has(mime)) {
      throw new Error("unsupported in-memory image type");
    }
    if (
      typeof systemPrompt !== "string" ||
      systemPrompt.trim().length === 0 ||
      systemPrompt.length > 16_000
    ) {
      throw new Error("systemPrompt must contain 1 to 16000 characters");
    }

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.#fetch(`${this.#baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.#model,
        stream: false,
        think: false,
        keep_alive: this.#keepAlive,
        options: this.#options,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: `Viewer question: ${question}`,
            images: [imageBase64],
          },
        ],
      }),
      signal: combinedSignal,
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`local vision request failed with HTTP ${response.status}`);
    }
    const payload = await readBoundedJson(response);
    if (payload?.done === false || payload?.done_reason === "length") {
      throw new Error("local vision returned a truncated response");
    }
    const content = payload?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("local vision returned an empty response");
    }
    return content.trim().slice(0, 2_000);
  }
}
