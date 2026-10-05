import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_VENDOR_TOOLS = new Set([
  "obsbot_wake",
  "obsbot_sleep",
  "obsbot_status",
  "obsbot_gimbal_move",
  "obsbot_gimbal_recenter",
  "obsbot_capture_snapshot",
]);

const MAX_SNAPSHOT_BASE64_CHARS = 8_000_000;
const SNAPSHOT_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

function isBoundedBase64(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_SNAPSHOT_BASE64_CHARS
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function terminalDeviceError() {
  const error = new Error("camera device is terminally shut down");
  error.code = "DEVICE_TERMINAL";
  return error;
}

function moduleUrl(root, relativePath) {
  return pathToFileURL(join(resolve(root), relativePath)).href;
}

export class ObsbotDevice {
  #backend;
  #interruptPromise = null;
  #nextEpoch = 1;
  #restart;
  #terminalRequested = false;
  #terminalShutdownPromise = null;

  constructor({ invoke, shutdown = async () => {}, restart = null }) {
    this.#backend = this.#wrapBackend({ invoke, shutdown });
    this.#restart = restart;
  }

  #wrapBackend({ invoke, shutdown }) {
    return {
      invoke,
      shutdown: shutdown ?? (async () => {}),
      epoch: this.#nextEpoch++,
      closed: false,
      shutdownPromise: null,
    };
  }

  static async fromVendor({ root, log = () => {} }) {
    const [managerModule, factoryModule, toolsModule] = await Promise.all([
      import(moduleUrl(root, "dist/device/manager.js")),
      import(moduleUrl(root, "dist/device/helper-factory.js")),
      import(moduleUrl(root, "dist/mcp/tools.js")),
    ]);

    const makeBackend = () => {
      let manager;
      manager = new managerModule.DeviceManager(
        factoryModule.helperFactory(() => manager),
        { log },
      );
      const definitions = toolsModule.createTools(manager, undefined, false);
      const handlers = new Map(
        definitions
          .filter((definition) => ALLOWED_VENDOR_TOOLS.has(definition.name))
          .map((definition) => [definition.name, definition.handler]),
      );
      const invoke = async (tool, args) => {
        const handler = handlers.get(tool);
        if (!handler) throw new Error(`camera operation is not exposed: ${tool}`);
        return handler(args);
      };
      return {
        invoke,
        shutdown: () => manager.shutdown(),
      };
    };
    const backend = makeBackend();
    return new ObsbotDevice({
      ...backend,
      restart: async () => makeBackend(),
    });
  }

  #assertBackendCurrent(backend) {
    if (this.#terminalRequested) {
      throw terminalDeviceError();
    }
    if (backend.closed || backend !== this.#backend) {
      throw new Error(`camera backend epoch ${backend.epoch} changed or closed`);
    }
  }

  #scrubResult(result) {
    if (!result || typeof result !== "object") return;
    if (Array.isArray(result)) {
      for (const child of result) this.#scrubResult(child);
      return;
    }
    for (const [key, value] of Object.entries(result)) {
      if ((key === "data" || key.toLowerCase() === "base64") && typeof value === "string") {
        result[key] = "";
      } else {
        this.#scrubResult(value);
      }
    }
  }

  async #callOn(backend, tool, args = {}) {
    this.#assertBackendCurrent(backend);
    const result = await backend.invoke(tool, args);
    try {
      this.#assertBackendCurrent(backend);
    } catch (error) {
      this.#scrubResult(result);
      throw error;
    }
    if (result?.ok === false || result?.isError === true) {
      this.#scrubResult(result);
      throw new Error(`${tool} failed`);
    }
    return result;
  }

  async #call(tool, args = {}) {
    const backend = this.#backend;
    return this.#callOn(backend, tool, args);
  }

  async snapshot({ maxDim, quality, settleMs }) {
    const backend = this.#backend;
    await this.#callOn(backend, "obsbot_wake");
    const result = await this.#callOn(backend, "obsbot_capture_snapshot", {
      resolution: maxDim,
      quality,
      settleMs,
      source: "device",
    });
    try {
      const image = result?.content?.find((entry) => entry?.type === "image");
      const metadataEntry = result?.content?.find((entry) => entry?.type === "text");
      if (!image || !isBoundedBase64(image.data)) {
        throw new Error("camera returned invalid snapshot image data");
      }
      if (!SNAPSHOT_MIME_TYPES.has(image.mimeType)) {
        throw new Error("camera returned unsupported snapshot image type");
      }
      let metadata;
      try {
        metadata = JSON.parse(metadataEntry?.text ?? "{}");
      } catch {
        throw new Error("camera returned invalid snapshot metadata");
      }
      if (
        !Number.isInteger(metadata.width)
        || !Number.isInteger(metadata.height)
        || metadata.width < 1
        || metadata.height < 1
        || metadata.width > maxDim
        || metadata.height > maxDim
      ) {
        throw new Error("camera returned invalid snapshot dimensions");
      }
      return {
        base64: image.data,
        mime: image.mimeType,
        width: metadata.width,
        height: metadata.height,
      };
    } finally {
      this.#scrubResult(result);
    }
  }

  async move(yaw, pitch) {
    await this.#call("obsbot_gimbal_move", { yaw, pitch, roll: 0 });
  }

  async recenter() {
    await this.#call("obsbot_gimbal_recenter");
  }

  async status() {
    return this.#call("obsbot_status");
  }

  async sleep() {
    const result = await this.#call("obsbot_sleep");
    if (result?.ok !== true) {
      throw new Error("obsbot_sleep did not acknowledge success");
    }
  }

  interruptAndSleep() {
    if (this.#terminalRequested) {
      return Promise.reject(terminalDeviceError());
    }
    if (this.#interruptPromise) return this.#interruptPromise;
    this.#interruptPromise = this.#doInterruptAndSleep();
    return this.#interruptPromise;
  }

  async #doInterruptAndSleep() {
    if (typeof this.#restart !== "function") {
      throw new Error("camera backend cannot be restarted for an emergency stop");
    }
    const oldBackend = this.#backend;
    await this.#shutdownBackend(oldBackend);
    if (this.#terminalRequested) {
      throw terminalDeviceError();
    }
    const replacement = this.#wrapBackend(await this.#restart());
    if (this.#terminalRequested) {
      await this.#shutdownBackend(replacement);
      throw terminalDeviceError();
    }
    this.#backend = replacement;
    const result = await this.#callOn(replacement, "obsbot_sleep");
    if (result?.ok !== true) {
      throw new Error("obsbot_sleep did not acknowledge success");
    }
    // This acknowledges command delivery only; no physical pose is read.
    return true;
  }

  #shutdownBackend(backend) {
    if (!backend.shutdownPromise) {
      backend.closed = true;
      backend.shutdownPromise = Promise.resolve().then(() => backend.shutdown());
    }
    return backend.shutdownPromise;
  }

  shutdown() {
    this.#terminalRequested = true;
    if (!this.#terminalShutdownPromise) {
      this.#terminalShutdownPromise = this.#completeTerminalShutdown();
    }
    return this.#terminalShutdownPromise;
  }

  async #completeTerminalShutdown() {
    const errors = [];
    const backendAtIntent = this.#backend;
    try {
      await this.#shutdownBackend(backendAtIntent);
    } catch (error) {
      errors.push(error);
    }
    if (this.#interruptPromise) {
      try {
        await this.#interruptPromise;
      } catch (error) {
        if (error?.code !== "DEVICE_TERMINAL" && !errors.includes(error)) {
          errors.push(error);
        }
      }
    }
    const finalBackend = this.#backend;
    if (finalBackend !== backendAtIntent) {
      try {
        await this.#shutdownBackend(finalBackend);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "camera device terminal shutdown failed");
    }
  }
}
