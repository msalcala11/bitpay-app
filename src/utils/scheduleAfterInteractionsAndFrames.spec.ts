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
});
