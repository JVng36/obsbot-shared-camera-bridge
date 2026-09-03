export class CameraSession {
  #allowedAgents;
  #expiresAtMs;
  #now;
  #reason = null;
  #stopped = false;

  constructor({ durationMs, now = Date.now, allowedAgents }) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new TypeError("durationMs must be a positive finite number");
    }
    if (!Array.isArray(allowedAgents) || allowedAgents.length === 0) {
      throw new TypeError("allowedAgents must be a non-empty array");
    }
    this.#now = now;
    this.#expiresAtMs = now() + durationMs;
    this.#allowedAgents = new Set(allowedAgents);
  }

  #refreshExpiry() {
    if (!this.#stopped && this.#now() >= this.#expiresAtMs) {
      this.#stopped = true;
      this.#reason = "expired";
    }
  }

  assertActive(agent) {
    if (!this.#allowedAgents.has(agent)) {
      throw new Error("agent is not allowed to use this camera session");
    }
    this.#refreshExpiry();
    if (this.#stopped) {
      throw new Error(`camera session is off (${this.#reason})`);
    }
  }

  stop(agent, _reason = "") {
    if (!this.#allowedAgents.has(agent)) {
      throw new Error("agent is not allowed to stop this camera session");
    }
    if (this.#stopped) return;
    this.#stopped = true;
    this.#reason = "stopped";
  }

  terminate(reason) {
    if (!new Set(["operator", "expired", "failure"]).has(reason)) {
      throw new Error("invalid bounded termination reason");
    }
    if (this.#stopped) return;
    this.#stopped = true;
    this.#reason = reason;
  }

  status() {
    this.#refreshExpiry();
    return {
      active: !this.#stopped,
      expiresAtMs: this.#expiresAtMs,
      reason: this.#reason,
    };
  }
}
