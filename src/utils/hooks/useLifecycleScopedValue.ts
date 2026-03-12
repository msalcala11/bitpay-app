import {useCallback, useMemo, useState} from 'react';

export const useLifecycleScopedValue = <T>(lifecycleKey: string) => {
  const [scopedState, setScopedState] = useState<{
    lifecycleKey: string;
    value?: T;
  }>();

  const value = useMemo(() => {
    return scopedState?.lifecycleKey === lifecycleKey
      ? scopedState.value
      : undefined;
  }, [lifecycleKey, scopedState]);

  const setValue = useCallback(
    (nextValue?: T) => {
      setScopedState({
        lifecycleKey,
        value: nextValue,
      });
    },
    [lifecycleKey],
  );

  return [value, setValue] as const;
};

export default useLifecycleScopedValue;
