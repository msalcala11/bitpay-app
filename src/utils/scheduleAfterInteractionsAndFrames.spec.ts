import {InteractionManager} from 'react-native';
import {scheduleAfterInteractionsAndFrames} from './scheduleAfterInteractionsAndFrames';

const globalWithAnimation = global as typeof global & {
  requestAnimationFrame?: typeof requestAnimationFrame;
  cancelAnimationFrame?: typeof cancelAnimationFrame;
};

const flushMicrotasks = async (times = 4) => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

const mockInteractionManager = () => {
  let interactionCallback: (() => void) | undefined;
  const taskCancel = jest.fn();

  jest
    .spyOn(InteractionManager, 'runAfterInteractions')
    .mockImplementation(callback => {
      interactionCallback = callback;
      return {cancel: taskCancel} as any;
    });

  return {
    fire: () => {
      if (!interactionCallback) {
        throw new Error('Interaction callback was not scheduled.');
      }

      interactionCallback();
    },
    taskCancel,
  };
};

const installRafQueue = () => {
  let nextFrameId = 1;
  const pendingFrames: Array<{id: number; callback: FrameRequestCallback}> = [];

  globalWithAnimation.requestAnimationFrame = jest.fn(
    (callback: FrameRequestCallback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      pendingFrames.push({id: frameId, callback});
      return frameId;
    },
  ) as typeof requestAnimationFrame;

  const cancelAnimationFrameMock = jest.fn((frameId: number) => {
    const frameIndex = pendingFrames.findIndex(frame => frame.id === frameId);
    if (frameIndex >= 0) {
      pendingFrames.splice(frameIndex, 1);
    }
  });

  globalWithAnimation.cancelAnimationFrame =
    cancelAnimationFrameMock as typeof cancelAnimationFrame;

  return {
    cancelAnimationFrameMock,
    fireNextFrame: () => {
      const nextFrame = pendingFrames.shift();
      if (!nextFrame) {
        throw new Error('No animation frame is pending.');
      }

      nextFrame.callback(0);
      return nextFrame.id;
    },
    getPendingFrameIds: () => pendingFrames.map(frame => frame.id),
  };
};

describe('scheduleAfterInteractionsAndFrames', () => {
  const originalRequestAnimationFrame =
    globalWithAnimation.requestAnimationFrame;
  const originalCancelAnimationFrame = globalWithAnimation.cancelAnimationFrame;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    globalWithAnimation.requestAnimationFrame = undefined;
    globalWithAnimation.cancelAnimationFrame = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
    globalWithAnimation.requestAnimationFrame = originalRequestAnimationFrame;
    globalWithAnimation.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it('cancels before the interaction callback fires', async () => {
    const {fire, taskCancel} = mockInteractionManager();
    const callback = jest.fn();
    const handle = scheduleAfterInteractionsAndFrames({
      callback,
      fallbackMs: 25,
    });
    let doneResolvedCount = 0;

    void handle.done.then(() => {
      doneResolvedCount += 1;
    });

    handle.cancel();
    handle.cancel();
    fire();
    jest.advanceTimersByTime(25);
    jest.runOnlyPendingTimers();
    await handle.done;
    await flushMicrotasks();

    expect(handle.signal.aborted).toBe(true);
    expect(taskCancel).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
    expect(doneResolvedCount).toBe(1);
  });

  it('cancels after interactions resolve but before RAF frames complete', async () => {
    const {fire, taskCancel} = mockInteractionManager();
    const raf = installRafQueue();
    const callback = jest.fn();
    const handle = scheduleAfterInteractionsAndFrames({
      callback,
      fallbackMs: 25,
    });

    fire();
    expect(raf.getPendingFrameIds()).toHaveLength(1);

    raf.fireNextFrame();
    const [pendingSecondFrameId] = raf.getPendingFrameIds();
    expect(pendingSecondFrameId).toBeDefined();

    handle.cancel();
    jest.runOnlyPendingTimers();
    await handle.done;
    await flushMicrotasks();

    expect(taskCancel).toHaveBeenCalledTimes(1);
    expect(raf.cancelAnimationFrameMock).toHaveBeenCalledWith(
      pendingSecondFrameId,
    );
    expect(raf.getPendingFrameIds()).toHaveLength(0);
    expect(callback).not.toHaveBeenCalled();
  });

  it('cancels after RAF scheduling but before the timeout callback runs', async () => {
    const {fire, taskCancel} = mockInteractionManager();
    const raf = installRafQueue();
    const callback = jest.fn();
    const handle = scheduleAfterInteractionsAndFrames({
      callback,
      fallbackMs: 25,
    });

    fire();
    raf.fireNextFrame();
    raf.fireNextFrame();
    expect(callback).not.toHaveBeenCalled();

    handle.cancel();
    jest.runOnlyPendingTimers();
    await handle.done;
    await flushMicrotasks();

    expect(taskCancel).toHaveBeenCalledTimes(1);
    expect(raf.getPendingFrameIds()).toHaveLength(0);
    expect(callback).not.toHaveBeenCalled();
  });

  it('runs the fallback when interactions never finish', async () => {
    jest
      .spyOn(InteractionManager, 'runAfterInteractions')
      .mockImplementation(() => ({cancel: jest.fn()} as any));

    const callback = jest.fn(async () => undefined);
    const handle = scheduleAfterInteractionsAndFrames({
      callback,
      fallbackMs: 25,
    });

    jest.advanceTimersByTime(24);
    expect(callback).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    jest.runOnlyPendingTimers();
    await flushMicrotasks();
    await handle.done;

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toBe(handle.signal);
  });

  it('keeps done pending while a fallback-started callback is still running', async () => {
    const {fire} = mockInteractionManager();
    const raf = installRafQueue();
    let resolveCallback: (() => void) | undefined;
    const callback = jest.fn(
      () =>
        new Promise<void>(resolve => {
          resolveCallback = resolve;
        }),
    );
    const handle = scheduleAfterInteractionsAndFrames({
      callback,
      fallbackMs: 25,
    });

    let doneResolved = false;
    void handle.done.then(() => {
      doneResolved = true;
    });

    jest.advanceTimersByTime(25);
    jest.runOnlyPendingTimers();
    await flushMicrotasks();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(doneResolved).toBe(false);

    fire();
    await flushMicrotasks();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(raf.getPendingFrameIds()).toHaveLength(0);
    expect(doneResolved).toBe(false);

    resolveCallback?.();
    await flushMicrotasks();
    await handle.done;

    expect(doneResolved).toBe(true);
  });

  it('forwards async callback failures to onError', async () => {
    const {fire} = mockInteractionManager();
    const error = new Error('boom');
    const onError = jest.fn();
    const handle = scheduleAfterInteractionsAndFrames({
      callback: async () => {
        throw error;
      },
      onError,
    });

    fire();
    jest.runOnlyPendingTimers();
    await flushMicrotasks();
    await handle.done;

    expect(onError).toHaveBeenCalledWith(error);
  });

  it('does not report errors after cancellation while the callback is running', async () => {
    const {fire} = mockInteractionManager();
    const callbackError = new Error('cancelled after start');
    const onError = jest.fn();
    let releaseCallback: (() => void) | undefined;
    const callback = jest.fn(async (signal: AbortSignal) => {
      await new Promise<void>(resolve => {
        releaseCallback = () => {
          expect(signal.aborted).toBe(true);
          resolve();
        };
      });

      throw callbackError;
    });
    const handle = scheduleAfterInteractionsAndFrames({
      callback,
      onError,
    });

    fire();
    jest.runOnlyPendingTimers();
    await flushMicrotasks();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(releaseCallback).toBeDefined();

    handle.cancel();
    releaseCallback?.();
    await flushMicrotasks();
    await handle.done;

    expect(handle.signal.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('ignores exceptions thrown by onError handlers', async () => {
    const {fire} = mockInteractionManager();
    const error = new Error('boom');
    const onError = jest.fn(() => {
      throw new Error('secondary');
    });
    const handle = scheduleAfterInteractionsAndFrames({
      callback: async () => {
        throw error;
      },
      onError,
    });

    fire();
    jest.runOnlyPendingTimers();
    await flushMicrotasks();
    await handle.done;

    expect(onError).toHaveBeenCalledWith(error);
  });
});
