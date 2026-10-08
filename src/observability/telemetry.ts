import { SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";

const tracer = trace.getTracer("agency-os");

/**
 * Runs work inside an active span, marking it OK on success and recording the
 * exception plus ERROR status before rethrowing on failure.
 *
 * @param name - Span name.
 * @param attributes - Span attributes set at start.
 * @param work - Operation to trace.
 * @returns The operation's result.
 */
export async function withTelemetrySpan<T>(name: string, attributes: Attributes, work: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await work();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Adds an event to the currently active span. No-op when no span is active.
 *
 * @param name - Event name.
 * @param attributes - Event attributes.
 */
export function addTelemetryEvent(name: string, attributes: Attributes = {}) {
  trace.getActiveSpan()?.addEvent(name, attributes);
}
