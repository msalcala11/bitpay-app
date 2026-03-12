import {useCallback, useRef} from 'react';
import {InteractionManager} from 'react-native';

export type ScheduledAfterInteractionsHandle = {
  cancel: () => void;
};

type ScheduleTrackedWorkOptions = {
  label: string;
  context?: string;
  timeoutMs?: number;
};

const DEFAULT_INTERACTION_WATCHDOG_MS = 1200;

const isPromiseLike = (value: unknown): value is Promise<unknown> => {
  return !!value && typeof (value as Promise<unknown>).then === 'function';
};

const warnScheduledWorkError = (args: {
  error: unknown;
  label: string;
  context?: string;
}) => {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    const details = args.context ? ` (${args.context})` : '';
    // eslint-disable-next-line no-console
    console.warn(
      `[BalanceHistoryChart] Scheduled work failed: ${args.label}${details}`,
      args.error,
    );
  }
};

const scheduleAfterInteractionsAndFrames = (args: {
  cb: () => void | Promise<void>;
  onError?: (error: unknown) => void;
  onSettled?: () => void;
  timeoutMs?: number;
}): ScheduledAfterInteractionsHandle => {
  let cancelled = false;
  let hasQueuedExecution = false;
  let hasInvokedCallback = false;
  let hasSettled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let watchdogTimeout: ReturnType<typeof setTimeout> | undefined;
  let firstFrame: number | undefined;
  let secondFrame: number | undefined;
  let runningPromise: Promise<unknown> | undefined;

  const clearPending = () => {
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
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    if (watchdogTimeout) {
      clearTimeout(watchdogTimeout);
      watchdogTimeout = undefined;
    }
  };

  const settle = () => {
    if (hasSettled) {
      return;
    }

    hasSettled = true;
    clearPending();
    args.onSettled?.();
  };

  const execute = () => {
    if (cancelled || hasQueuedExecution) {
      return;
    }

    hasQueuedExecution = true;
    timeout = setTimeout(() => {
      timeout = undefined;

      if (cancelled) {
        settle();
        return;
      }

      hasInvokedCallback = true;

      try {
        const maybePromise = args.cb();
        if (isPromiseLike(maybePromise)) {
          runningPromise = Promise.resolve(maybePromise)
            .catch(error => {
              args.onError?.(error);
            })
            .finally(() => {
              runningPromise = undefined;
              settle();
            });
          return;
        }
      } catch (error) {
        args.onError?.(error);
      }

      settle();
    }, 0);
  };

  const task = InteractionManager.runAfterInteractions(() => {
    if (cancelled || hasQueuedExecution) {
      return;
    }

    if (watchdogTimeout) {
      clearTimeout(watchdogTimeout);
      watchdogTimeout = undefined;
    }

    if (typeof requestAnimationFrame === 'function') {
      firstFrame = requestAnimationFrame(() => {
        if (cancelled || hasQueuedExecution) {
          return;
        }

        secondFrame = requestAnimationFrame(execute);
      });
      return;
    }

    execute();
  });

  watchdogTimeout = setTimeout(
    execute,
    args.timeoutMs ?? DEFAULT_INTERACTION_WATCHDOG_MS,
  );

  return {
    cancel: () => {
      if (cancelled) {
        return;
      }

      cancelled = true;
      task.cancel();
      clearPending();

      if (!hasInvokedCallback && !runningPromise) {
        settle();
      }
    },
  };
};

export const useTrackedInteractionWork = () => {
  const scheduledHandlesRef = useRef<Set<ScheduledAfterInteractionsHandle>>(
    new Set(),
  );

  const cancelAllScheduledWork = useCallback(() => {
    for (const handle of scheduledHandlesRef.current) {
      handle.cancel();
    }
  }, []);

  const scheduleTrackedWork = useCallback(
    (
      cb: () => void | Promise<void>,
      options: ScheduleTrackedWorkOptions,
    ): ScheduledAfterInteractionsHandle => {
      let handle: ScheduledAfterInteractionsHandle | undefined;
      let trackedHandle: ScheduledAfterInteractionsHandle | undefined;

      const removeHandle = () => {
        if (trackedHandle) {
          scheduledHandlesRef.current.delete(trackedHandle);
        }
      };

      handle = scheduleAfterInteractionsAndFrames({
        cb,
        timeoutMs: options.timeoutMs,
        onSettled: removeHandle,
        onError: error => {
          warnScheduledWorkError({
            error,
            label: options.label,
            context: options.context,
          });
        },
      });

      trackedHandle = {
        cancel: () => {
          handle?.cancel();
        },
      };

      scheduledHandlesRef.current.add(trackedHandle);
      return trackedHandle;
    },
    [],
  );

  return {
    scheduleTrackedWork,
    cancelAllScheduledWork,
  };
};

export default useTrackedInteractionWork;
