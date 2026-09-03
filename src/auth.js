import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function normalizeSource(source) {
  if (typeof source !== "string") return "";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(source);
  return mapped ? mapped[1] : source;
}

export class TokenAuthenticator {
  #entries;

  constructor(tokensByAgent, { allowedSourcesByAgent = {} } = {}) {
    if (!tokensByAgent || typeof tokensByAgent !== "object") {
      throw new TypeError("tokensByAgent must be an object");
    }

    const seen = new Set();
    this.#entries = Object.entries(tokensByAgent).map(([agent, token]) => {
      if (typeof token !== "string" || token.length < 32) {
        throw new TypeError(`token for ${agent} must be at least 32 characters`);
      }
      const tokenDigest = digest(token);
      const key = tokenDigest.toString("hex");
      if (seen.has(key)) {
        throw new TypeError("agent tokens must be unique");
      }
      seen.add(key);
      const configuredSources = allowedSourcesByAgent[agent];
      let allowedSources = null;
      if (configuredSources !== undefined) {
        if (!Array.isArray(configuredSources) || configuredSources.length === 0) {
          throw new TypeError(`allowed sources for ${agent} must be a non-empty array`);
        }
        const normalized = configuredSources.map(normalizeSource);
        if (normalized.some((source) => isIP(source) === 0)) {
          throw new TypeError(`allowed sources for ${agent} must contain only IP addresses`);
        }
        allowedSources = new Set(normalized);
      }
      return { agent, tokenDigest, allowedSources };
    });
  }

  authenticate(header, sourceAddress) {
    if (typeof header !== "string") {
      throw new Error("unauthorized");
    }
    const match = /^Bearer ([^\s]+)$/.exec(header);
    if (!match) {
      throw new Error("unauthorized");
    }

    const candidate = digest(match[1]);
    for (const entry of this.#entries) {
      if (timingSafeEqual(candidate, entry.tokenDigest)) {
        if (
          entry.allowedSources !== null &&
          !entry.allowedSources.has(normalizeSource(sourceAddress))
        ) {
          throw new Error("unauthorized");
        }
        return entry.agent;
      }
    }
    throw new Error("unauthorized");
  }
}
