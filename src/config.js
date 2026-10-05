import { isIP } from "node:net";

export const MAX_SESSION_MINUTES = 10_080;
export const PRINCIPAL_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const MIN_PRINCIPALS = 1;
export const MAX_PRINCIPALS = 8;

export function isPrincipalId(value) {
  return typeof value === "string" && PRINCIPAL_ID_PATTERN.test(value) && value !== "system";
}

export function isPromptActorId(value) {
  return value === "system" || isPrincipalId(value);
}

function isAllowedBindHost(host) {
  if (host === "127.0.0.1" || host === "::1") return true;
  if (isIP(host) !== 4) return false;
  const octets = host.split(".").map(Number);
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

export function validateVisionControls(vision) {
  let endpoint;
  try { endpoint = new URL(vision.baseUrl); } catch { throw new Error("invalid local vision endpoint"); }
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname.toLowerCase()) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new Error("local vision endpoint must be an HTTP loopback origin without credentials or suffixes");
  }
  if (typeof vision.model !== "string" || !vision.model.trim() || vision.model.length > 200) {
    throw new Error("local vision model must contain 1 to 200 characters");
  }
  for (const [key, max] of [["num_ctx", 32768], ["num_predict", 1000]]) {
    if (vision[key] !== undefined && (!Number.isInteger(vision[key]) || vision[key] < 1 || vision[key] > max)) {
      throw new Error(`local vision ${key} is outside its integer bounds`);
    }
  }
  const residency = vision.keep_alive;
  if (residency !== undefined) {
    const match = typeof residency === "string" && /^([1-9][0-9]*)(s|m)$/.exec(residency);
    const seconds = match ? Number(match[1]) * (match[2] === "m" ? 60 : 1) : residency;
    if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 0 || seconds > 120) {
      throw new Error("local vision keep_alive must be 0 to 120 seconds or a bounded s/m duration");
    }
  }
}

export function validateRuntimeConfig(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("runtime config must be an object");
  }
  if (!isAllowedBindHost(input.bindHost)) {
    throw new Error("bindHost must be a loopback or Tailscale address");
  }
  if (!Number.isInteger(input.port) || input.port < 1_024 || input.port > 65_535) {
    throw new Error("port must be an integer from 1024 through 65535");
  }
  if (
    !Number.isInteger(input.minutes) ||
    input.minutes < 1 ||
    input.minutes > MAX_SESSION_MINUTES
  ) {
    throw new Error(`session minutes must be an integer from 1 through ${MAX_SESSION_MINUTES}`);
  }
  if (!input.tokens || typeof input.tokens !== "object" || Array.isArray(input.tokens)) {
    throw new Error("per-agent tokens are required");
  }
  const principals = Object.keys(input.tokens);
  if (principals.length < MIN_PRINCIPALS || principals.length > MAX_PRINCIPALS) {
    throw new Error(`configure ${MIN_PRINCIPALS} to ${MAX_PRINCIPALS} principals`);
  }
  if (principals.some((principal) => !isPrincipalId(principal))) {
    throw new Error(
      "principal IDs must match ^[a-z][a-z0-9_-]{0,31}$ and must not use reserved names",
    );
  }
  if (!isPrincipalId(input.operatorPrincipal) || !principals.includes(input.operatorPrincipal)) {
    throw new Error("operatorPrincipal must name one configured non-reserved principal");
  }
  if (!input.sources || typeof input.sources !== "object" || Array.isArray(input.sources)) {
    throw new Error("source bindings are required for every principal");
  }
  const sourceKeys = Object.keys(input.sources);
  const tokenKeySet = new Set(principals);
  const sourceKeySet = new Set(sourceKeys);
  if (
    sourceKeys.length !== principals.length
    || principals.some((principal) => !sourceKeySet.has(principal))
    || sourceKeys.some((key) => !tokenKeySet.has(key))
  ) {
    throw new Error("token and source principal key sets must match exactly");
  }
  const tokenValues = principals.map((principal) => input.tokens[principal]);
  if (
    tokenValues.some(
      (value) => typeof value === "string" && /GENERATE|REPLACE|PLACEHOLDER/i.test(value),
    )
  ) {
    throw new Error("placeholder credentials are forbidden");
  }
  if (
    tokenValues.some(
      (value) => typeof value !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(value),
    )
  ) {
    throw new Error("all per-agent tokens must be 43-128 character Base64URL values");
  }
  if (new Set(tokenValues).size !== tokenValues.length) {
    throw new Error("per-agent tokens must be unique");
  }
  for (const principal of principals) {
    const addresses = input.sources[principal];
    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw new Error("source bindings must be a non-empty IP list for every principal");
    }
    if (addresses.some((address) => typeof address !== "string" || isIP(address) === 0)) {
      throw new Error(`source bindings for ${principal} must contain only IP addresses`);
    }
  }
  if (!input.vision || typeof input.vision !== "object") {
    throw new Error("local vision configuration is required");
  }
  if (typeof input.vision.baseUrl !== "string" || typeof input.vision.model !== "string") {
    throw new Error("local vision baseUrl and model are required");
  }

  validateVisionControls(input.vision);

  return {
    bindHost: input.bindHost,
    port: input.port,
    minutes: input.minutes,
    durationMs: input.minutes * 60_000,
    operatorPrincipal: input.operatorPrincipal,
    principals: [...principals],
    tokens: Object.fromEntries(
      principals.map((principal) => [principal, input.tokens[principal]]),
    ),
    sources: Object.fromEntries(
      principals.map((principal) => [principal, [...input.sources[principal]]]),
    ),
    vision: {
      baseUrl: input.vision.baseUrl, model: input.vision.model,
      ...Object.fromEntries(["num_ctx", "num_predict", "keep_alive"].filter(key => input.vision[key] !== undefined).map(key => [key, input.vision[key]])),
    },
  };
}
