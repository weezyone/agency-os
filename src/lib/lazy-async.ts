/**
 * Defers an async factory until first call, then memoizes the in-flight
 * promise. A rejected attempt clears the cache so the next call retries
 * instead of serving a permanently failed value.
 *
 * @param factory - Produces the value on first use.
 * @returns A thunk returning the shared promise.
 */
export function lazyAsync<T>(factory: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      pending = factory().catch((error) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}
