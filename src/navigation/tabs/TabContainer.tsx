import React, {memo, useMemo} from 'react';
import {Platform} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import styled from 'styled-components/native';
import {ScreenContainer} from '../../components/styled/Containers';

const TabContainerFactory = (insetsTop: number) => {
  const getPlatformSpecificContainer = Platform.select({
    ios: () => styled.View`
      flex: 1;
      margin-top: ${insetsTop}px;
    `,
  });
  return getPlatformSpecificContainer
    ? getPlatformSpecificContainer()
    : ScreenContainer;
};

const TabContainer: React.FC<React.PropsWithChildren> = ({children}) => {
  const insets = useSafeAreaInsets();
  const Container = useMemo(
    () => TabContainerFactory(insets.top),
    [insets.top],
  );
  return <Container>{children}</Container>;
};

export default memo(TabContainer);
