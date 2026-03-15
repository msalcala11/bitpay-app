import {InteractionManager} from 'react-native';
import {isAbortError} from './abort';

const DEFAULT_SCHEDULE_AFTER_INTERACTIONS_FALLBACK_MS = 700;

export type ScheduledAfterInteractionsHandle = {
  cancel: () => void;
  done: Promise<void>;
  signal: AbortSignal;
};

export const scheduleAfterInteractionsAndFrames = (args: {
  callback: (signal: AbortSignal) => void | Promise<void>;
  fallbackMs?: number;
  onError?: (error: unknown) => void;
}): ScheduledAfterInteractionsHandle => {
  const controller = new AbortController();
  let cancelled = false;
  let didRun = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let fallbackTimeout: ReturnType<typeof setTimeout> | undefined;
  let firstFrame: number | undefined;
  let secondFrame: number | undefined;
  let resolveDone: (() => void) | undefined;

  const done = new Promise<void>(resolve => {
    resolveDone = resolve;
  });

  const finish = () => {
    resolveDone?.();
    resolveDone = undefined;
  };

  const clearScheduledTimers = () => {
    if (fallbackTimeout) {
      clearTimeout(fallbackTimeout);
      fallbackTimeout = undefined;
    }
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };

  const reportError = (error: unknown) => {
    if (controller.signal.aborted || isAbortError(error)) {
      return;
    }

    args.onError?.(error);
  };

  const runCallback = () => {
    if (cancelled || didRun) {
      finish();
      return;
    }

    didRun = true;
    clearScheduledTimers();

    timeout = setTimeout(() => {
      if (cancelled) {
        finish();
        return;
      }

      Promise.resolve()
        .then(() => args.callback(controller.signal))
        .catch(reportError)
        .finally(finish);
    }, 0);
  };

  const task = InteractionManager.runAfterInteractions(() => {
    if (cancelled || didRun) {
      finish();
      return;
    }

    if (typeof requestAnimationFrame === 'function') {
      firstFrame = requestAnimationFrame(() => {
        if (cancelled || didRun) {
          finish();
          return;
        }

        secondFrame = requestAnimationFrame(runCallback);
      });
      return;
    }

    runCallback();
  });

  if (!cancelled && !didRun) {
    fallbackTimeout = setTimeout(
      runCallback,
      Math.max(
        0,
        Math.floor(
          args.fallbackMs ?? DEFAULT_SCHEDULE_AFTER_INTERACTIONS_FALLBACK_MS,
        ),
      ),
    );
  }

  return {
    cancel: () => {
      if (cancelled) {
        return;
      }

      cancelled = true;
      controller.abort();
      task.cancel();
      clearScheduledTimers();

      if (
        typeof firstFrame === 'number' &&
        typeof cancelAnimationFrame === 'function'
      ) {
        cancelAnimationFrame(firstFrame);
      }
      if (
        typeof secondFrame === 'number' &&
        typeof cancelAnimationFrame === 'function'
      ) {
        cancelAnimationFrame(secondFrame);
      }

      finish();
    },
    done,
    signal: controller.signal,
  };
};
