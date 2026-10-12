// INTERNAL ONLY - DO NOT MERGE. This gate never changes persistor failure flags.
import type {Storage} from 'redux-persist';

export type ReplayPause = {drained: Promise<void>; release(): void};
const drain = async (operations: readonly Promise<unknown>[]) => {
  const results = await Promise.allSettled(operations);
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
};

export const createInternalReplayWriteGate = () => {
  let pauses = 0;
  const active = new Set<Promise<unknown>>();
  const waiting: Array<() => void> = [];
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (pauses) {
      return new Promise((resolve, reject) => {
        waiting.push(() => {
          try {
            resolve(run(operation));
          } catch (error) {
            reject(error);
          }
        });
      });
    }
    const result = operation(); // Normal, unpaused calls still start synchronously.
    active.add(result);
    result.then(
      () => active.delete(result),
      () => active.delete(result),
    );
    return result;
  };
  return {
    run,
    suspend(): ReplayPause {
      pauses++;
      let released = false;
      return {
        drained: drain([...active]),
        release() {
          if (released) return;
          released = true;
          if (--pauses === 0) waiting.splice(0).forEach(resume => resume());
        },
      };
    },
  };
};

export const gateInternalReplayStorageWrites = (storage: Storage) => {
  const gate = createInternalReplayWriteGate();
  const set = storage.setItem;
  const remove = storage.removeItem;
  const get = storage.getItem;
  storage.setItem = (key, value) => gate.run(() => set(key, value));
  storage.removeItem = key => gate.run(() => remove(key));
  // Reads can repair/sanitize persist:root via write-back, so drain/gate them too.
  storage.getItem = key => gate.run(() => get(key));
  return gate;
};

export const combineReplayPauses = (...pauses: ReplayPause[]): ReplayPause => ({
  drained: drain(pauses.map(pause => pause.drained)),
  release: () => [...pauses].reverse().forEach(pause => pause.release()),
});
