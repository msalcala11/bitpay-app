import {isNumberSharedValue} from './sharedValueGuards';

describe('isNumberSharedValue', () => {
  it('returns true for objects with an own finite numeric value', () => {
    expect(isNumberSharedValue({value: 1})).toBe(true);
    expect(isNumberSharedValue({value: 0})).toBe(true);
  });

  it('returns false for non-number, nullish, and missing value inputs', () => {
    expect(isNumberSharedValue({value: '1'})).toBe(false);
    expect(isNumberSharedValue(null)).toBe(false);
    expect(isNumberSharedValue(undefined)).toBe(false);
    expect(isNumberSharedValue({foo: 1})).toBe(false);
  });

  it('returns false when value is inherited instead of an own property', () => {
    expect(isNumberSharedValue(Object.create({value: 1}))).toBe(false);
  });

  it('returns false for non-finite numeric values', () => {
    expect(isNumberSharedValue({value: Number.NaN})).toBe(false);
    expect(isNumberSharedValue({value: Number.POSITIVE_INFINITY})).toBe(false);
    expect(isNumberSharedValue({value: Number.NEGATIVE_INFINITY})).toBe(
      false,
    );
  });
});
