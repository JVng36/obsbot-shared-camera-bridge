import { DEFAULT_VLM_SYSTEM_PROMPT } from "./prompt-store.js";

const MAX_VISION_RESPONSE_BYTES = 16_384;

async function readBoundedJson(response) {
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
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

  constructor({
    baseUrl = "http://127.0.0.1:11434",
    model = "qwen3.8:27b",
    fetchImpl = globalThis.fetch,
    timeoutMs = 60_000,
  } = {}) {
    this.#baseUrl = assertLoopback(baseUrl);
    this.#model = model;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
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
        keep_alive: "2m",
        options: {
          temperature: 0.2,
          num_predict: 300,
        },
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
    const content = payload?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("local vision returned an empty response");
    }
    return content.trim().slice(0, 2_000);
  }
}
