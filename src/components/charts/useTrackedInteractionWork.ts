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
  let didRun = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let watchdogTimeout: ReturnType<typeof setTimeout> | undefined;
  let firstFrame: number | undefined;
  let secondFrame: number | undefined;

  const clearPending = () => {
    if (typeof firstFrame === 'number' && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(firstFrame);
    }
    if (typeof secondFrame === 'number' && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(secondFrame);
    }
    if (timeout) {
      clearTimeout(timeout);
    }
    if (watchdogTimeout) {
      clearTimeout(watchdogTimeout);
    }
  };

  const settle = () => {
    clearPending();
    args.onSettled?.();
  };

  const execute = () => {
    if (cancelled || didRun) {
      return;
    }

    didRun = true;
    timeout = setTimeout(() => {
      if (cancelled) {
        settle();
        return;
      }

      try {
        const maybePromise = args.cb();
        if (isPromiseLike(maybePromise)) {
          maybePromise.catch(error => {
            args.onError?.(error);
          });
        }
      } catch (error) {
        args.onError?.(error);
      }
      settle();
    }, 0);
  };

  const task = InteractionManager.runAfterInteractions(() => {
    if (cancelled || didRun) {
      return;
    }

    if (watchdogTimeout) {
      clearTimeout(watchdogTimeout);
      watchdogTimeout = undefined;
    }

    if (typeof requestAnimationFrame === 'function') {
      firstFrame = requestAnimationFrame(() => {
        if (cancelled || didRun) {
          return;
        }

        secondFrame = requestAnimationFrame(execute);
      });
      return;
    }

    execute();
  });

  watchdogTimeout = setTimeout(execute, args.timeoutMs ?? DEFAULT_INTERACTION_WATCHDOG_MS);

  return {
    cancel: () => {
      if (cancelled) {
        return;
      }

      cancelled = true;
      task.cancel();
      settle();
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
    scheduledHandlesRef.current.clear();
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
          removeHandle();
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
