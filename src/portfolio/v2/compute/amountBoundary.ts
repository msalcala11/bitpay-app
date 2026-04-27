export type AtomicDisplayUnitAmount = Readonly<{
  decimalString: string;
  approximateNumber: number;
}>;

export type AtomicDisplayUnitAmountInvalidReason =
  | 'invalidDisplayUnitsAtomic'
  | 'negativeDisplayUnitsAtomic'
  | 'invalidDisplayUnitDecimals'
  | 'nonFiniteDisplayUnits'
  | 'unsafeDisplayUnits';

export type InvalidAtomicDisplayUnitAmount = Readonly<{
  kind: 'invalidAmount';
  reason: AtomicDisplayUnitAmountInvalidReason;
}>;

export function isValidDisplayUnitDecimals(value: unknown): value is number {
  'worklet';

  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 30
  );
}

export function parseAtomicUnits(value: unknown): bigint | null {
  'worklet';

  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    return null;
  }

  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function pow10(value: number): bigint {
  'worklet';

  return 10n ** BigInt(value);
}

export function formatDisplayUnitAmountString(
  atomic: bigint,
  decimals: number,
): string {
  'worklet';

  if (atomic === 0n) {
    return '0';
  }

  const sign = atomic < 0n ? '-' : '';
  const abs = atomic < 0n ? -atomic : atomic;
  if (decimals === 0) {
    return `${sign}${abs.toString()}`;
  }

  const base = pow10(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, '0');
  const trimmedFraction = fraction.replace(/0+$/, '');

  return trimmedFraction
    ? `${sign}${whole.toString()}.${trimmedFraction}`
    : `${sign}${whole.toString()}`;
}

export function atomicToDisplayUnitAmount(args: {
  atomic: string;
  decimals: number;
  allowNegative?: boolean;
}): AtomicDisplayUnitAmount | InvalidAtomicDisplayUnitAmount {
  'worklet';

  const atomic = parseAtomicUnits(args.atomic);
  if (atomic === null) {
    return {kind: 'invalidAmount', reason: 'invalidDisplayUnitsAtomic'};
  }
  if (atomic < 0n && args.allowNegative !== true) {
    return {kind: 'invalidAmount', reason: 'negativeDisplayUnitsAtomic'};
  }
  if (!isValidDisplayUnitDecimals(args.decimals)) {
    return {kind: 'invalidAmount', reason: 'invalidDisplayUnitDecimals'};
  }

  const decimalString = formatDisplayUnitAmountString(atomic, args.decimals);
  const approximateNumber = Number(decimalString);
  if (!Number.isFinite(approximateNumber)) {
    return {kind: 'invalidAmount', reason: 'nonFiniteDisplayUnits'};
  }
  if (Math.abs(approximateNumber) > Number.MAX_SAFE_INTEGER) {
    return {kind: 'invalidAmount', reason: 'unsafeDisplayUnits'};
  }

  return {decimalString, approximateNumber};
}
