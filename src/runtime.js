export class CameraRuntime {
  #bridge;
  #clearTimer;
  #device;
  #http;
  #now;
  #onError;
  #setTimer;
  #shutdownPromise = null;
  #started = false;
  #timer = null;

  constructor({
    bridge,
    http,
    device,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onError = () => {},
  }) {
    this.#bridge = bridge;
    this.#http = http;
    this.#device = device;
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#onError = onError;
  }

  async start({ host, port }) {
    if (this.#started) throw new Error("camera runtime already started");
    this.#started = true;
    try {
      await this.#http.listen({ host, port });
    } catch (listenError) {
      try {
        await this.shutdown("failure");
      } catch (cleanupError) {
        const cleanupErrors = cleanupError instanceof AggregateError
          ? cleanupError.errors
          : [cleanupError];
        throw new AggregateError(
          [listenError, ...cleanupErrors],
          `camera runtime startup failed: ${listenError.message}`,
        );
      }
      throw listenError;
    }
    const delay = Math.max(0, this.#bridge.status().expiresAtMs - this.#now());
    this.#timer = this.#setTimer(() => {
      void this.shutdown("expired").catch(this.#onError);
    }, delay);
  }

  shutdown(reason, { bridgeAlreadyQuiesced = false } = {}) {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownPromise = (async () => {
      if (this.#timer !== null) {
        this.#clearTimer(this.#timer);
        this.#timer = null;
      }
      const operations = [];
      if (!bridgeAlreadyQuiesced) {
        operations.push(() => this.#bridge.terminate(reason));
      }
      operations.push(
        () => this.#http.close(),
        () => this.#device.shutdown(),
      );
      const outcomes = await Promise.allSettled(
        operations.map((operation) => Promise.resolve().then(operation)),
      );
      const errors = outcomes
        .filter((outcome) => outcome.status === "rejected")
        .map((outcome) => outcome.reason);
      if (errors.length > 0) {
        throw new AggregateError(errors, "camera runtime cleanup failed");
      }
    })();
    return this.#shutdownPromise;
  }
}
