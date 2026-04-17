export function createSerialExecutor() {
  let tail: Promise<unknown> = Promise.resolve();

  return function runSerial<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
