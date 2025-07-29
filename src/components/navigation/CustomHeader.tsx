import React from 'react';
import {View, Platform} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import styled, {css} from 'styled-components/native';
import HeaderBackButton from '../back/HeaderBackButton';
import {HeaderTitle as StyledHeaderTitle} from '../styled/Text';

/*
  A lightweight custom header that replaces the default native-stack toolbar so
  we can fully control safe-area handling on Android & iOS.  It uses the same
  Back button component and typography already defined in the codebase.
*/

interface HeaderProps {
  navigation: any;
  back?: {title: string};
  options: any;
}

const Wrapper = styled.View<{bg: string}>`
  ${({bg}) =>
    css`
      background-color: ${bg};
    `}
`;

const Container = styled.View`
  flex-direction: row;
  align-items: center;
  height: 56px; /* standard toolbar height */
  padding: 0 16px;
`;

const TitleContainer = styled.View`
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  align-items: center;
  justify-content: center;
`;

const CustomHeader: React.FC<HeaderProps> = ({navigation, back, options}) => {
  const insets = useSafeAreaInsets();
  const bgColor = options.headerStyle?.backgroundColor || 'transparent';

  // Header title resolution logic from React-Navigation docs
  const title =
    options.headerTitle !== undefined
      ? options.headerTitle
      : options.title !== undefined
      ? options.title
      : options.route?.name;

  return (
    <Wrapper style={{paddingTop: insets.top}} bg={bgColor}>
      <Container>
        {back ? <HeaderBackButton onPress={navigation.goBack} /> : <View />}
        <TitleContainer>
          {typeof title === 'function' ? (
            // If a function is provided (rare), call it with default props
            title({tintColor: options.headerTintColor})
          ) : (
            <StyledHeaderTitle>{title}</StyledHeaderTitle>
          )}
        </TitleContainer>
        
      </Container>
    </Wrapper>
  );
};

export default CustomHeader;
