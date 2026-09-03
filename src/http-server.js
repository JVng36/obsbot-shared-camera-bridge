import { createServer } from "node:http";

import { isPromptActorId } from "./config.js";
import { isSafeObservationText } from "./observation-text.js";

const MAX_BODY_BYTES = 131_072;
const KNOWN_PATHS = new Set([
  "/health",
  "/v1/status",
  "/v1/look",
  "/v1/ptz/move",
  "/v1/ptz/recenter",
  "/v1/stop",
  "/v1/prompt/status",
  "/v1/prompt/get",
  "/v1/prompt/replace",
  "/v1/prompt/append",
  "/v1/prompt/reset",
]);

function securityHeaders() {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...securityHeaders(),
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("request body is too large");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("request body must be a JSON object");
    }
    return parsed;
  } catch (error) {
    if (error.message === "request body must be a JSON object") throw error;
    throw new Error("request body must be valid JSON");
  }
}

function statusForError(error) {
  const message = String(error?.message ?? "");
  if (/unauthorized/i.test(message)) return 401;
  if (/PTZ lease is held|prompt revision conflict/i.test(message)) return 409;
  if (/wait before looking|look limit reached/i.test(message)) return 429;
  if (/session is off|session stopped|expired/i.test(message)) return 410;
  if (/question|privacy zone|request body|enabled must|prompt must|append text|expectedRevision/i.test(message)) return 400;
  return 500;
}

function publicMessageForStatus(status) {
  return {
    400: "invalid camera bridge request",
    401: "unauthorized camera bridge request",
    409: "camera bridge conflict",
    410: "camera session is unavailable",
    429: "camera bridge rate limit exceeded",
    500: "camera bridge request failed",
  }[status] ?? "camera bridge request failed";
}

const isBool = (value) => typeof value === "boolean";
const isInt = (value) => Number.isInteger(value);
const isNumber = (value) => Number.isFinite(value);
const isText = (value) => typeof value === "string";
const isNullableText = (value) => value === null || isText(value);
const isNullableNumber = (value) => value === null || isNumber(value);
const isSha256 = (value) => isText(value) && /^[a-f0-9]{64}$/.test(value);
const isPromptActor = isPromptActorId;
const isPromptAction = (value) => ["initial", "replace", "append", "reset"].includes(value);

function isPromptHistory(value) {
  if (!Array.isArray(value) || value.length > 20) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const keys = Object.keys(entry).sort();
    const expected = ["action", "chars", "revision", "sha256", "updatedAtMs", "updatedBy"];
    return JSON.stringify(keys) === JSON.stringify(expected)
      && isInt(entry.revision)
      && isNumber(entry.updatedAtMs)
      && isPromptActor(entry.updatedBy)
      && isPromptAction(entry.action)
      && isInt(entry.chars)
      && isSha256(entry.sha256);
  });
}

const PROMPT_METADATA_FIELDS = {
  revision: isInt,
  updatedAtMs: isNumber,
  updatedBy: isPromptActor,
  action: isPromptAction,
  chars: isInt,
  sha256: isSha256,
  history: isPromptHistory,
};

const PROMPT_METADATA_REQUIRED = [
  "revision", "updatedAtMs", "updatedBy", "action", "chars", "sha256", "history",
];

const RESPONSE_SCHEMAS = {
  "/v1/status": {
    required: [
      "active", "expiresAtMs", "promptRevision", "promptUpdatedAtMs",
      "promptUpdatedBy", "promptAction", "promptChars", "promptSha256",
    ],
    fields: {
      active: isBool,
      expiresAtMs: isNumber,
      reason: isNullableText,
      ptzLeaseHolder: isNullableText,
      ptzLeaseExpiresAtMs: isNullableNumber,
      promptRevision: isInt,
      promptUpdatedAtMs: isNumber,
      promptUpdatedBy: isPromptActor,
      promptAction: isPromptAction,
      promptChars: isInt,
      promptSha256: isSha256,
    },
  },
  "/v1/look": {
    required: ["viewer", "description", "width", "height", "promptRevision"],
    fields: {
      viewer: isText,
      observedAtMs: isNumber,
      description: isSafeObservationText,
      width: isInt,
      height: isInt,
      remainingLooks: isInt,
      promptRevision: isInt,
    },
  },
  "/v1/ptz/move": {
    required: ["yaw", "pitch", "leaseHolder", "leaseExpiresAtMs"],
    fields: {
      yaw: isNumber,
      pitch: isNumber,
      leaseHolder: isText,
      leaseExpiresAtMs: isNumber,
    },
  },
  "/v1/ptz/recenter": {
    required: ["recentered", "leaseHolder", "leaseExpiresAtMs"],
    fields: {
      recentered: isBool,
      leaseHolder: isText,
      leaseExpiresAtMs: isNumber,
    },
  },
  "/v1/stop": {
    required: [
      "active", "parked", "promptRevision", "promptUpdatedAtMs",
      "promptUpdatedBy", "promptAction", "promptChars", "promptSha256",
    ],
    fields: {
      active: isBool,
      expiresAtMs: isNumber,
      reason: isNullableText,
      ptzLeaseHolder: isNullableText,
      ptzLeaseExpiresAtMs: isNullableNumber,
      parked: isBool,
      promptRevision: isInt,
      promptUpdatedAtMs: isNumber,
      promptUpdatedBy: isPromptActor,
      promptAction: isPromptAction,
      promptChars: isInt,
      promptSha256: isSha256,
    },
  },
  "/v1/prompt/status": {
    required: PROMPT_METADATA_REQUIRED,
    fields: PROMPT_METADATA_FIELDS,
  },
  "/v1/prompt/get": {
    required: [...PROMPT_METADATA_REQUIRED, "prompt"],
    fields: { ...PROMPT_METADATA_FIELDS, prompt: isText },
  },
  "/v1/prompt/replace": {
    required: PROMPT_METADATA_REQUIRED,
    fields: PROMPT_METADATA_FIELDS,
  },
  "/v1/prompt/append": {
    required: PROMPT_METADATA_REQUIRED,
    fields: PROMPT_METADATA_FIELDS,
  },
  "/v1/prompt/reset": {
    required: PROMPT_METADATA_REQUIRED,
    fields: PROMPT_METADATA_FIELDS,
  },
};

const FORBIDDEN_RESPONSE_KEYS = new Set([
  "base64", "image", "imagebase64", "media", "path", "content", "data", "url",
]);

function hasForbiddenResponseKey(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenResponseKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    FORBIDDEN_RESPONSE_KEYS.has(key.toLowerCase()) || hasForbiddenResponseKey(child));
}

function validateBridgeResponse(pathname, value) {
  const schema = RESPONSE_SCHEMAS[pathname];
  if (!schema || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid camera bridge response");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !(key in schema.fields))) {
    throw new Error("invalid camera bridge response");
  }
  if (schema.required.some((key) => !(key in value))) {
    throw new Error("invalid camera bridge response");
  }
  if (keys.some((key) => !schema.fields[key](value[key]))) {
    throw new Error("invalid camera bridge response");
  }
  if (hasForbiddenResponseKey(value)) {
    throw new Error("invalid camera bridge response");
  }
  return value;
}

export function createCameraHttpServer({ bridge, auth, logger = () => {}, onStopped = () => {} }) {
  const sockets = new Set();
  let closePromise = null;
  const scheduleStopped = () => {
    setImmediate(() => {
      try {
        Promise.resolve(onStopped()).catch(() => {
          logger({ event: "runtime_shutdown_callback_failed" });
        });
      } catch {
        logger({ event: "runtime_shutdown_callback_failed" });
      }
    });
  };
  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    let pathname = "<invalid>";
    let logPath = "<invalid>";
    let agent = null;
    let status = 500;
    try {
      try {
        pathname = new URL(request.url ?? "/", "http://camera.local").pathname;
        logPath = KNOWN_PATHS.has(pathname) ? pathname : "<unknown>";
      } catch {
        status = 400;
        sendJson(response, status, { error: publicMessageForStatus(status) });
        return;
      }
      agent = auth.authenticate(
        request.headers.authorization,
        request.socket.remoteAddress,
      );
      if (request.method === "GET" && pathname === "/health") {
        status = 200;
        sendJson(response, status, { service: "shared-camera", active: bridge.status().active });
        return;
      }
      if (request.method === "GET" && pathname === "/v1/status") {
        status = 200;
        sendJson(response, status, validateBridgeResponse(pathname, bridge.status()));
        return;
      }
      if (request.method === "GET" && pathname === "/v1/prompt/status") {
        status = 200;
        sendJson(response, status, validateBridgeResponse(pathname, bridge.promptStatus(agent)));
        return;
      }
      if (request.method === "GET" && pathname === "/v1/prompt/get") {
        status = 200;
        sendJson(response, status, validateBridgeResponse(pathname, bridge.promptGet(agent)));
        return;
      }

      if (request.method !== "POST") {
        status = 404;
        sendJson(response, status, { error: "not found" });
        return;
      }

      const body = await readJson(request);
      let result;
      if (pathname === "/v1/look") {
        result = await bridge.look(agent, body);
      } else if (pathname === "/v1/ptz/move") {
        result = await bridge.move(agent, body);
      } else if (pathname === "/v1/ptz/recenter") {
        result = await bridge.recenter(agent);
      } else if (pathname === "/v1/prompt/replace") {
        result = bridge.promptReplace(agent, body);
      } else if (pathname === "/v1/prompt/append") {
        result = bridge.promptAppend(agent, body);
      } else if (pathname === "/v1/prompt/reset") {
        result = bridge.promptReset(agent, body);
      } else if (pathname === "/v1/stop") {
        let stopPromise;
        try {
          stopPromise = bridge.stop(agent, body);
        } finally {
          scheduleStopped();
        }
        result = await stopPromise;
      } else {
        status = 404;
        sendJson(response, status, { error: "not found" });
        return;
      }
      status = 200;
      sendJson(response, status, validateBridgeResponse(pathname, result));
    } catch (error) {
      status = statusForError(error);
      sendJson(response, status, { error: publicMessageForStatus(status) });
    } finally {
      logger({
        event: "request",
        method: request.method,
        path: logPath,
        status,
        agent,
        durationMs: Date.now() - startedAt,
      });
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  return {
    listen({ host, port }) {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    address() {
      return server.address();
    },
    close({ graceMs = 500 } = {}) {
      if (closePromise) return closePromise;
      closePromise = new Promise((resolve, reject) => {
        if (!server.listening) {
          for (const socket of sockets) socket.destroy();
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          server.closeAllConnections?.();
          for (const socket of sockets) socket.destroy();
        }, graceMs);
        timer.unref?.();
        server.close((error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
      });
      return closePromise;
    },
  };
}
