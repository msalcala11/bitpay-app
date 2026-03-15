import {InteractionManager} from 'react-native';
import {scheduleAfterInteractionsAndFrames} from './scheduleAfterInteractionsAndFrames';

const globalWithAnimation = global as typeof global & {
  requestAnimationFrame?: typeof requestAnimationFrame;
  cancelAnimationFrame?: typeof cancelAnimationFrame;
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

  it('cancels scheduled work before it runs', async () => {
    const taskCancel = jest.fn();
    let interactionCallback: (() => void) | undefined;
    jest
      .spyOn(InteractionManager, 'runAfterInteractions')
      .mockImplementation(callback => {
        interactionCallback = callback;
        return {cancel: taskCancel} as any;
      });

    const callback = jest.fn();
    const handle = scheduleAfterInteractionsAndFrames({
      callback,
      fallbackMs: 25,
    });

    handle.cancel();
    interactionCallback?.();
    jest.advanceTimersByTime(25);
    jest.runOnlyPendingTimers();
    await handle.done;

    expect(taskCancel).toHaveBeenCalledTimes(1);
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
    await handle.done;

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toBe(handle.signal);
  });

  it('forwards async callback failures to onError', async () => {
    jest
      .spyOn(InteractionManager, 'runAfterInteractions')
      .mockImplementation(callback => {
        callback();
        return {cancel: jest.fn()} as any;
      });

    const error = new Error('boom');
    const onError = jest.fn();
    const handle = scheduleAfterInteractionsAndFrames({
      callback: async () => {
        throw error;
      },
      onError,
    });

    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await handle.done;

    expect(onError).toHaveBeenCalledWith(error);
  });

  it('keeps done pending while a fallback-started callback is still running', async () => {
    let interactionCallback: (() => void) | undefined;
    jest
      .spyOn(InteractionManager, 'runAfterInteractions')
      .mockImplementation(callback => {
        interactionCallback = callback;
        return {cancel: jest.fn()} as any;
      });

    const requestedFrames: Array<FrameRequestCallback> = [];
    globalWithAnimation.requestAnimationFrame = jest.fn(callback => {
      requestedFrames.push(callback);
      return requestedFrames.length;
    }) as typeof requestAnimationFrame;
    globalWithAnimation.cancelAnimationFrame = jest.fn();

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
    await Promise.resolve();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(doneResolved).toBe(false);

    interactionCallback?.();
    await Promise.resolve();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(requestedFrames).toHaveLength(0);
    expect(doneResolved).toBe(false);

    resolveCallback?.();
    await Promise.resolve();
    await handle.done;

    expect(doneResolved).toBe(true);
  });

  it('ignores exceptions thrown by onError handlers', async () => {
    jest
      .spyOn(InteractionManager, 'runAfterInteractions')
      .mockImplementation(callback => {
        callback();
        return {cancel: jest.fn()} as any;
      });

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

    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await handle.done;

    expect(onError).toHaveBeenCalledWith(error);
  });
});
