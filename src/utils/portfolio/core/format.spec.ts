import {formatBigIntDecimal} from './format';

describe('formatBigIntDecimal', () => {
  it('trims trailing zeros by default', () => {
    expect(formatBigIntDecimal(100000000n, 8, 8)).toBe('1');
    expect(formatBigIntDecimal(123000000n, 8, 8)).toBe('1.23');
  });

  it('preserves trailing zeros when requested', () => {
    expect(
      formatBigIntDecimal(100000000n, 8, 8, {trimTrailingZeros: false}),
    ).toBe('1.00000000');
    expect(
      formatBigIntDecimal(123000000n, 8, 8, {trimTrailingZeros: false}),
    ).toBe('1.23000000');
  });
});
