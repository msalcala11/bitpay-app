import React, {useCallback} from 'react';
import {Circle, Group} from '@shopify/react-native-skia';
import type {SelectionDotProps} from 'react-native-graph';
import {
  runOnJS,
  useAnimatedReaction,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

// The selection dot animation & styling is copied from ExchangeRate.tsx so that
// all charts can share an identical look and feel.
const ChartSelectionDot = ({
  isActive,
  color,
  circleX,
  circleY,
}: SelectionDotProps): React.ReactElement => {
  const outerRadius = useSharedValue(0);
  const innerRadius = useSharedValue(0);

  const setIsActive = useCallback(
    (active: boolean) => {
      outerRadius.value = withSpring(active ? 9 : 0, {
        mass: 1,
        stiffness: 1000,
        damping: 50,
        velocity: 0,
      });
      innerRadius.value = withSpring(active ? 4 : 0, {
        mass: 1,
        stiffness: 1000,
        damping: 50,
        velocity: 0,
      });
    },
    [innerRadius, outerRadius],
  );

  useAnimatedReaction(
    () => isActive.value,
    active => {
      runOnJS(setIsActive)(active);
    },
    [setIsActive],
  );

  return (
    <Group>
      <Circle
        cx={circleX}
        cy={circleY}
        r={outerRadius}
        color={color}
        opacity={0.18}
      />
      <Circle cx={circleX} cy={circleY} r={innerRadius} color={color} />
    </Group>
  );
};

export default ChartSelectionDot;
