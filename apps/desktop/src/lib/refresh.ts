/**
 * Global "data is refreshing" counter.
 *
 * Projects, bug lists and detail fetches call `beginRefresh()` around their
 * live (network) request; the title bar subscribes and shows a centered
 * indicator. Cache hits never touch this counter, so offline-first rendering
 * stays instant.
 */
let count = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

/** Marks the start of a live refresh; call the returned function when done. */
export const beginRefresh = (): (() => void) => {
  count += 1;
  emit();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    count = Math.max(0, count - 1);
    emit();
  };
};

export const subscribeRefresh = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getRefreshing = (): boolean => count > 0;
