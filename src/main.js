import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { TokenAuthenticator } from "./auth.js";
import { SharedCameraBridge } from "./bridge.js";
import { validateRuntimeConfig } from "./config.js";
import { createCameraHttpServer } from "./http-server.js";
import { ObsbotDevice } from "./obsbot-device.js";
import { OllamaVision } from "./ollama-vision.js";
import { PromptStore } from "./prompt-store.js";
import { CameraRuntime } from "./runtime.js";
import { CameraSession } from "./session.js";

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--config", "--vendor-root", "--minutes"]).has(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    if (value === undefined) throw new Error(`${flag} requires a value`);
    values[flag] = value;
  }
  if (!values["--config"] || !values["--vendor-root"]) {
    throw new Error("--config and --vendor-root are required");
  }
  let minutes;
  if (values["--minutes"] !== undefined) {
    minutes = Number(values["--minutes"]);
    if (!Number.isInteger(minutes)) throw new Error("--minutes must be an integer");
  }
  return {
    configPath: values["--config"],
    vendorRoot: values["--vendor-root"],
    ...(minutes === undefined ? {} : { minutes }),
  };
}

function contentFreeLog(event) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

export async function initializeMedia(
  config,
  vendorRoot,
  {
    DeviceClass = ObsbotDevice,
    VisionClass = OllamaVision,
    deviceLog = () => {},
  } = {},
) {
  const vision = new VisionClass(config.vision);
  const device = await DeviceClass.fromVendor({
    root: vendorRoot,
    log: deviceLog,
  });
  return { device, vision };
}

export function initializeBridge(
  config,
  {
    device,
    vision,
    now = Date.now,
    promptStore = new PromptStore({ now, allowedActors: config.principals }),
  },
) {
  const session = new CameraSession({
    durationMs: config.durationMs,
    allowedAgents: config.principals,
    now,
  });
  const bridge = new SharedCameraBridge({
    session,
    device,
    vision,
    promptStore,
    now,
  });
  return { bridge, session, promptStore };
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const rawConfig = JSON.parse(await readFile(resolve(args.configPath), "utf8"));
  const config = validateRuntimeConfig({
    ...rawConfig,
    minutes: args.minutes ?? rawConfig.minutes,
  });

  const auth = new TokenAuthenticator(config.tokens, {
    allowedSourcesByAgent: config.sources,
  });
  const { device, vision } = await initializeMedia(config, args.vendorRoot, {
    deviceLog: () => contentFreeLog({ event: "device_diagnostic" }),
  });
  const { bridge } = initializeBridge(config, { device, vision });

  let runtime;
  const reportShutdownFailure = (error) => {
    contentFreeLog({ event: "shutdown_failure", errorType: error?.name ?? "Error" });
    process.exitCode = 1;
  };
  const http = createCameraHttpServer({
    bridge,
    auth,
    logger: contentFreeLog,
    onStopped: () => {
      return runtime
        .shutdown("operator", { bridgeAlreadyQuiesced: true })
        .catch(reportShutdownFailure);
    },
  });
  runtime = new CameraRuntime({
    bridge,
    http,
    device,
    onError: reportShutdownFailure,
  });
  await runtime.start({ host: config.bindHost, port: config.port });

  const status = bridge.status();
  contentFreeLog({
    event: "session_active",
    bindHost: config.bindHost,
    port: config.port,
    expiresAt: new Date(status.expiresAtMs).toISOString(),
    promptRevision: status.promptRevision,
    promptSha256: status.promptSha256,
    rawFrameNetworkExposure: false,
  });

  const stopFromSignal = (signal) => {
    contentFreeLog({ event: "operator_stop", signal });
    void runtime.shutdown("operator").catch(reportShutdownFailure);
  };
  process.once("SIGINT", () => stopFromSignal("SIGINT"));
  process.once("SIGTERM", () => stopFromSignal("SIGTERM"));
  return { runtime, bridge, device, config };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  run().catch((error) => {
    process.stderr.write(`Shared camera failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}
