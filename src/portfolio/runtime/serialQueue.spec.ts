import {createSerialExecutor} from './serialQueue';

describe('createSerialExecutor', () => {
  it('runs async tasks strictly in submission order', async () => {
    const runSerial = createSerialExecutor();
    const order: string[] = [];

    const first = runSerial(async () => {
      order.push('first:start');
      await new Promise(resolve => setTimeout(resolve, 10));
      order.push('first:end');
      return 'first';
    });

    const second = runSerial(async () => {
      order.push('second:start');
      order.push('second:end');
      return 'second';
    });

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('keeps later tasks running after a rejection', async () => {
    const runSerial = createSerialExecutor();
    const order: string[] = [];

    const first = runSerial(async () => {
      order.push('first:start');
      throw new Error('boom');
    });

    const second = runSerial(async () => {
      order.push('second:start');
      order.push('second:end');
      return 'ok';
    });

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
    expect(order).toEqual(['first:start', 'second:start', 'second:end']);
  });
});
