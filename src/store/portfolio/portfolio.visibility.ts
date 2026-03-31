let homeRootDirectlyVisible = false;
const visibilityListeners = new Set<() => void>();

const notifyVisibilityListeners = () => {
  const listeners = Array.from(visibilityListeners);
  visibilityListeners.clear();
  listeners.forEach(listener => listener());
};

export const setPortfolioPopulateHomeRootVisible = (visible: boolean) => {
  homeRootDirectlyVisible = visible;
  if (visible) {
    notifyVisibilityListeners();
  }
};

export const waitForPortfolioPopulateHomeRootVisible = async (args?: {
  shouldAbort?: () => boolean;
  pollIntervalMs?: number;
}): Promise<boolean> => {
  const shouldAbort = args?.shouldAbort;
  const pollIntervalMs = args?.pollIntervalMs ?? 500;

  while (!homeRootDirectlyVisible) {
    if (shouldAbort?.()) {
      return false;
    }

    await new Promise<void>(resolve => {
      let settled = false;
      const listener = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        visibilityListeners.delete(listener);
        resolve();
      };
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        visibilityListeners.delete(listener);
        resolve();
      }, pollIntervalMs);

      visibilityListeners.add(listener);
    });
  }

  return !shouldAbort?.();
};
