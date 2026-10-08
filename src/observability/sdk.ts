import { env } from "@/lib/env";

let sdk: { start(): void | Promise<void>; shutdown(): Promise<void> } | null = null;
let startPromise: Promise<void> | null = null;

function applyEnvironment() {
  const config = env();
  process.env.OTEL_SERVICE_NAME ||= config.OTEL_SERVICE_NAME;
  if (config.OTEL_EXPORTER_OTLP_ENDPOINT) {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||= config.OTEL_EXPORTER_OTLP_ENDPOINT;
  }
  if (config.OTEL_EXPORTER_OTLP_HEADERS) {
    process.env.OTEL_EXPORTER_OTLP_HEADERS ||= config.OTEL_EXPORTER_OTLP_HEADERS;
  }
  process.env.OTEL_TRACES_SAMPLER ||= "parentbased_traceidratio";
  process.env.OTEL_TRACES_SAMPLER_ARG ||= String(config.AGENCY_OTEL_SAMPLE_RATIO);
}

/**
 * Starts the OpenTelemetry NodeSDK once per process. No-ops unless
 * `AGENCY_OTEL_ENABLED`; the SDK is imported dynamically so its dependency
 * tree is only loaded when telemetry is actually on. Concurrent callers share
 * the same start promise.
 */
export async function startTelemetry() {
  if (!env().AGENCY_OTEL_ENABLED) return;
  if (startPromise) return startPromise;
  startPromise = (async () => {
    applyEnvironment();
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const instance = new NodeSDK({ serviceName: env().OTEL_SERVICE_NAME });
    await Promise.resolve(instance.start());
    sdk = instance;
  })();
  return startPromise;
}

/** Flushes and stops the running SDK, if any, so a later start can reinitialize. */
export async function shutdownTelemetry() {
  if (!sdk) return;
  const active = sdk;
  sdk = null;
  startPromise = null;
  await active.shutdown();
}
