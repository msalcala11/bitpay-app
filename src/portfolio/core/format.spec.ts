import {makeAtomicToUnitNumberConverter, parseAtomicToBigint, ratioBigIntToNumber} from './format';

describe('parseAtomicToBigint', () => {
  it('parses scientific-notation strings without relying on Intl', () => {
    const originalIntl = (globalThis as any).Intl;
    try {
      (globalThis as any).Intl = undefined;

      expect(parseAtomicToBigint('1e21')).toBe(1000000000000000000000n);
      expect(parseAtomicToBigint('1.2345e5')).toBe(123450n);
      expect(parseAtomicToBigint('9.99e-1')).toBe(0n);
      expect(parseAtomicToBigint('-4.2e3')).toBe(-4200n);
    } finally {
      (globalThis as any).Intl = originalIntl;
    }
  });

  it('parses scientific-notation numbers without relying on Intl', () => {
    const originalIntl = (globalThis as any).Intl;
    try {
      (globalThis as any).Intl = undefined;

      expect(parseAtomicToBigint(1e21)).toBe(1000000000000000000000n);
      expect(parseAtomicToBigint(1.2345e5)).toBe(123450n);
      expect(parseAtomicToBigint(9.99e-1)).toBe(0n);
      expect(parseAtomicToBigint(-4.2e3)).toBe(-4200n);
    } finally {
      (globalThis as any).Intl = originalIntl;
    }
  });
});

describe('bigint numeric helpers', () => {
  it('converts atomic bigint balances to unit numbers without string formatting', () => {
    const toEth = makeAtomicToUnitNumberConverter(18);
    expect(toEth(0n)).toBe(0);
    expect(toEth(1234500000000000000n)).toBeCloseTo(1.2345, 12);
    expect(toEth(-500000000000000000n)).toBeCloseTo(-0.5, 12);

    const toBtc = makeAtomicToUnitNumberConverter(8);
    expect(toBtc(123456789n)).toBeCloseTo(1.23456789, 12);
  });

  it('computes bigint ratios for cost-basis scaling', () => {
    expect(ratioBigIntToNumber(3n, 4n)).toBeCloseTo(0.75, 12);
    expect(ratioBigIntToNumber(-1n, 4n)).toBeCloseTo(-0.25, 12);
    expect(ratioBigIntToNumber(0n, 0n)).toBe(0);
  });
});
