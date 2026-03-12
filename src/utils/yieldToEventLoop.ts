export const yieldToEventLoop = (): Promise<void> => {
  return new Promise(resolve => {
    const setImmediateFn = (globalThis as {
      setImmediate?: (callback: () => void) => unknown;
    }).setImmediate;

    if (typeof setImmediateFn === 'function') {
      setImmediateFn(resolve);
      return;
    }

    setTimeout(resolve, 0);
  });
};

export default yieldToEventLoop;
