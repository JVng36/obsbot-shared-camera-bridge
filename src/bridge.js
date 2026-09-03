import { PromptStore } from "./prompt-store.js";
import { isSafeObservationText } from "./observation-text.js";

export class SharedCameraBridge {
  #cameraTail = Promise.resolve();
  #device;
  #generation = 0;
  #lookState = new Map();
  #maxLooksPerAgent;
  #minLookIntervalMs;
  #now;
  #ptzLease = { holder: null, expiresAtMs: 0 };
  #ptzLeaseMs;
  #promptStore;
  #quiescePromise = null;
  #session;
  #vision;
  #visionControllers = new Set();

  constructor({
    session,
    device,
    vision,
    promptStore = new PromptStore(),
    now = Date.now,
    minLookIntervalMs = 2_000,
    maxLooksPerAgent = 30,
    ptzLeaseMs = 15_000,
  }) {
    this.#session = session;
    this.#device = device;
    this.#vision = vision;
    this.#promptStore = promptStore;
    this.#now = now;
    this.#minLookIntervalMs = minLookIntervalMs;
    this.#maxLooksPerAgent = maxLooksPerAgent;
    this.#ptzLeaseMs = ptzLeaseMs;
  }

  async #withCamera(operation) {
    const previous = this.#cameraTail;
    let release;
    this.#cameraTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #assertActiveGeneration(agent, generation) {
    if (generation !== this.#generation) {
      throw new Error("camera operation discarded because the session stopped");
    }
    this.#session.assertActive(agent);
  }

  async #withAuthorizedCamera(agent, generation, operation) {
    return this.#withCamera(async () => {
      this.#assertActiveGeneration(agent, generation);
      return operation();
    });
  }

  async look(agent, { question = "What is directly visible right now?" } = {}) {
    this.#session.assertActive(agent);
    const generation = this.#generation;
    if (typeof question !== "string" || question.length < 1 || question.length > 240) {
      throw new Error("question must contain 1 to 240 characters");
    }

    const startedAt = this.#now();
    const state = this.#lookState.get(agent) ?? {
      completed: 0,
      inFlight: 0,
      lastStartedAt: null,
    };
    state.inFlight ??= 0;
    if (state.completed + state.inFlight >= this.#maxLooksPerAgent) {
      throw new Error("camera look limit reached for this session");
    }
    if (
      state.lastStartedAt !== null &&
      startedAt - state.lastStartedAt < this.#minLookIntervalMs
    ) {
      throw new Error("wait before looking again; camera access is one look at a time");
    }
    state.lastStartedAt = startedAt;
    state.inFlight += 1;
    this.#lookState.set(agent, state);

    let frame;
    try {
      try {
        frame = await this.#withAuthorizedCamera(agent, generation, () => this.#device.snapshot({
          maxDim: 1280,
          quality: 85,
          settleMs: 600,
        }));
      } catch (error) {
        if (generation !== this.#generation) {
          throw new Error("camera observation discarded because the session stopped");
        }
        throw error;
      }
      if (generation !== this.#generation) {
        throw new Error("camera observation discarded because the session stopped");
      }
      this.#session.assertActive(agent);

      const controller = new AbortController();
      this.#visionControllers.add(controller);
      const promptSnapshot = this.#promptStore.forInference();
      let description;
      try {
        description = await this.#vision.describe({
          imageBase64: frame.base64,
          mime: frame.mime,
          question,
          signal: controller.signal,
          systemPrompt: promptSnapshot.prompt,
        });
      } catch (error) {
        if (generation !== this.#generation) {
          throw new Error("camera observation discarded because the session stopped");
        }
        throw error;
      } finally {
        this.#visionControllers.delete(controller);
      }
      if (generation !== this.#generation) {
        throw new Error("camera observation discarded because the session stopped");
      }
      this.#session.assertActive(agent);
      if (!isSafeObservationText(description)) {
        throw new Error("local vision returned prohibited media-like observation text");
      }
      state.completed += 1;

      return {
        viewer: agent,
        observedAtMs: this.#now(),
        description: description.trim().slice(0, 2_000),
        width: frame.width,
        height: frame.height,
        remainingLooks: this.#maxLooksPerAgent - state.completed,
        promptRevision: promptSnapshot.revision,
      };
    } finally {
      if (frame && typeof frame.base64 === "string") frame.base64 = "";
      state.inFlight -= 1;
    }
  }

  async stop(agent, { reason = "" } = {}) {
    this.#session.stop(agent, reason);
    return this.#quiesce();
  }

  async terminate(reason) {
    this.#session.terminate(reason);
    return this.#quiesce();
  }

  #quiesce() {
    if (this.#quiescePromise) return this.#quiescePromise;
    this.#quiescePromise = this.#runQuiesce();
    return this.#quiescePromise;
  }

  async #runQuiesce() {
    this.#generation += 1;
    this.#ptzLease = { holder: null, expiresAtMs: 0 };
    for (const controller of this.#visionControllers) {
      controller.abort();
    }
    let parked = false;
    if (typeof this.#device.interruptAndSleep === "function") {
      try {
        parked = await this.#device.interruptAndSleep();
      } catch {
        if (typeof this.#device.shutdown === "function") {
          try {
            await this.#device.shutdown();
          } catch {
            // Session invalidation already won. Runtime cleanup will make its
            // own best-effort release attempt; parking remains unconfirmed.
          }
        }
      }
    } else {
      await this.#withCamera(() => this.#device.sleep());
      parked = true;
    }
    return { ...this.status(), parked };
  }

  #claimPtz(agent) {
    this.#session.assertActive(agent);
    const now = this.#now();
    const sessionDeadline = this.#session.status().expiresAtMs;
    if (
      this.#ptzLease.holder !== null &&
      this.#ptzLease.holder !== agent &&
      now < this.#ptzLease.expiresAtMs
    ) {
      throw new Error(`PTZ lease is held by ${this.#ptzLease.holder}`);
    }
    this.#ptzLease = {
      holder: agent,
      expiresAtMs: Math.min(now + this.#ptzLeaseMs, sessionDeadline),
    };
    return this.#ptzLease;
  }

  async move(agent, { yaw, pitch }) {
    this.#session.assertActive(agent);
    const generation = this.#generation;
    if (
      !Number.isFinite(yaw) ||
      !Number.isFinite(pitch) ||
      yaw < -60 ||
      yaw > 60 ||
      pitch < -30 ||
      pitch > 45
    ) {
      throw new Error("requested PTZ angle is outside the forward privacy zone");
    }
    const lease = this.#claimPtz(agent);
    await this.#withCamera(() => {
      this.#assertPtzExecution(agent, generation, lease);
      return this.#device.move(yaw, pitch);
    });
    return {
      yaw,
      pitch,
      leaseHolder: lease.holder,
      leaseExpiresAtMs: lease.expiresAtMs,
    };
  }

  async recenter(agent) {
    const generation = this.#generation;
    const lease = this.#claimPtz(agent);
    await this.#withCamera(() => {
      this.#assertPtzExecution(agent, generation, lease);
      return this.#device.recenter();
    });
    return {
      recentered: true,
      leaseHolder: lease.holder,
      leaseExpiresAtMs: lease.expiresAtMs,
    };
  }

  #assertPromptAccess(agent) {
    this.#session.assertActive(agent);
  }

  promptStatus(agent) {
    this.#assertPromptAccess(agent);
    return this.#promptStore.status(agent);
  }

  promptGet(agent) {
    this.#assertPromptAccess(agent);
    return this.#promptStore.get(agent);
  }

  promptReplace(agent, args) {
    this.#assertPromptAccess(agent);
    return this.#promptStore.replace(agent, args);
  }

  promptAppend(agent, args) {
    this.#assertPromptAccess(agent);
    return this.#promptStore.append(agent, args);
  }

  promptReset(agent, args) {
    this.#assertPromptAccess(agent);
    return this.#promptStore.reset(agent, args);
  }

  #assertPtzExecution(agent, generation, lease) {
    this.#assertActiveGeneration(agent, generation);
    if (
      this.#ptzLease !== lease ||
      lease.holder !== agent ||
      this.#now() >= lease.expiresAtMs
    ) {
      throw new Error("PTZ lease is no longer valid");
    }
  }

  status() {
    const status = this.#session.status();
    const now = this.#now();
    const prompt = this.#promptStore.summary();
    return {
      ...status,
      promptRevision: prompt.revision,
      promptUpdatedAtMs: prompt.updatedAtMs,
      promptUpdatedBy: prompt.updatedBy,
      promptAction: prompt.action,
      promptChars: prompt.chars,
      promptSha256: prompt.sha256,
      ptzLeaseHolder:
        status.active && now < this.#ptzLease.expiresAtMs
          ? this.#ptzLease.holder
          : null,
      ptzLeaseExpiresAtMs:
        status.active && now < this.#ptzLease.expiresAtMs
          ? this.#ptzLease.expiresAtMs
          : null,
    };
  }
}
