/**
 * Next.js instrumentation hook. `register()` runs once at server startup; here it
 * boots the OpenTelemetry SDK, but only on the Node.js runtime (not edge).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTelemetry } = await import("@/observability/sdk");
    await startTelemetry();
  }
}
