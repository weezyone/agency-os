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
