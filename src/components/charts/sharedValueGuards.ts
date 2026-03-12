import type {SharedValue} from 'react-native-reanimated';

export type NumberSharedValue =
  | SharedValue<number>
  | Readonly<SharedValue<number>>;

export const isNumberSharedValue = (
  value: unknown,
): value is NumberSharedValue => {
  if (value == null || typeof value !== 'object' || !('value' in value)) {
    return false;
  }

  const maybeNumber = (value as {value?: unknown}).value;
  return typeof maybeNumber === 'number' && Number.isFinite(maybeNumber);
};
