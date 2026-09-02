/**
 * Allow Node.js timers to stop keeping a worker alive while remaining safe in
 * DOM-typed builds where timer handles are represented as numbers.
 */
export function unrefTimer(timer: unknown) {
  if (!timer || (typeof timer !== "object" && typeof timer !== "function")) return;
  const candidate = timer as { unref?: () => void };
  candidate.unref?.();
}
