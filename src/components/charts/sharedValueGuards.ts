import type {SharedValue} from 'react-native-reanimated';

export type NumberSharedValue =
  | SharedValue<number>
  | Readonly<SharedValue<number>>;

export const isNumberSharedValue = (
  value: unknown,
): value is NumberSharedValue => {
  return value != null && typeof value === 'object' && 'value' in value;
};
