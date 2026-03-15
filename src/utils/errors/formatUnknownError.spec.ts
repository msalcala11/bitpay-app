import {formatUnknownError} from './formatUnknownError';

describe('formatUnknownError', () => {
  it('returns the message from an Error instance', () => {
    expect(formatUnknownError(new Error('boom'))).toBe('boom');
  });

  it('returns string inputs unchanged', () => {
    expect(formatUnknownError('plain string')).toBe('plain string');
  });

  it('stringifies plain objects', () => {
    expect(formatUnknownError({foo: 'bar'})).toBe('{"foo":"bar"}');
  });

  it('tolerates circular objects', () => {
    const value: {name: string; self?: unknown} = {name: 'loop'};
    value.self = value;

    expect(formatUnknownError(value)).toBe(
      '{"name":"loop","self":"[Circular]"}',
    );
  });

  it('does not throw for BigInt values', () => {
    expect(() => formatUnknownError(BigInt(123))).not.toThrow();
    expect(formatUnknownError(BigInt(123))).toContain('123n');
  });

  it('truncates very large objects', () => {
    const formatted = formatUnknownError(
      {payload: 'x'.repeat(256)},
      {maxLength: 32},
    );

    expect(formatted).toHaveLength(32);
    expect(formatted.endsWith('…')).toBe(true);
  });
});
