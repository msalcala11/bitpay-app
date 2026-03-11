export type YieldToEventLoopOptions = {
  preferRequestAnimationFrame?: boolean;
  preferSetImmediate?: boolean;
};

export const yieldToEventLoop = (
  options: YieldToEventLoopOptions = {},
): Promise<void> => {
  return new Promise(resolve => {
    const finish = () => setTimeout(resolve, 0);

    if (options.preferRequestAnimationFrame) {
      const requestAnimationFrameFn = (globalThis as {
        requestAnimationFrame?: (callback: () => void) => unknown;
      }).requestAnimationFrame;

      if (typeof requestAnimationFrameFn === 'function') {
        requestAnimationFrameFn(finish);
        return;
      }
    }

    if (options.preferSetImmediate) {
      const setImmediateFn = (globalThis as {
        setImmediate?: (callback: () => void) => unknown;
      }).setImmediate;

      if (typeof setImmediateFn === 'function') {
        setImmediateFn(resolve);
        return;
      }
    }

    finish();
  });
};

export default yieldToEventLoop;
