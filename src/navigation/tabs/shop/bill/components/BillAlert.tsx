import React from 'react';
import styled from 'styled-components/native';
import {Link, Paragraph} from '../../../../../components/styled/Text';
import {
  LightBlack,
  NeutralSlate,
  Slate30,
  SlateDark,
} from '../../../../../styles/colors';
import ClockSvg from '../../../../../../assets/img/bills/clock.svg';
import InfoSvg from '../../../home/components/InfoSvg';
import {Linking} from 'react-native';
import {useTheme} from 'styled-components/native';

const AlertContainer = styled.View`
  background-color: ${({theme}) => (theme.dark ? LightBlack : NeutralSlate)};
  flex-direction: row;
  padding: 16px 14px 21px;
  border-radius: 8px;
`;

const AlertBody = styled.View`
  margin-left: 14px;
`;

const AlertText = styled(Paragraph)`
  font-size: 14px;
  padding-right: 25px;
  line-height: 19px;
`;

const AlertLink = styled(Link)`
  font-size: 14px;
  line-height: 19px;
`;

const AlertHeader = styled(Paragraph)`
  font-weight: 500;
  margin-bottom: 3px;
`;

const IconContainer = styled.View`
  align-self: center;
`;

export default ({
  variant = 'noLateFees',
}: {
  variant?: 'noLateFees' | 'servicePaused';
}) => {
  const theme = useTheme();
  return (
    <AlertContainer>
      {variant === 'servicePaused' ? (
        <IconContainer>
          <InfoSvg
            width={22}
            height={22}
            color={theme.dark ? Slate30 : SlateDark}
          />
        </IconContainer>
      ) : (
        <ClockSvg style={{marginTop: 5}} />
      )}
      <AlertBody>
        {variant === 'servicePaused' ? (
          <>
            <AlertText>
              Bill Pay service will be temporarily paused beginning December
              26th, 2025 at 12:00 PM EST. At this time, we are unable to provide
              a confirmed timeline for when the Bill Pay service will resume.
              <AlertLink
                onPress={() =>
                  Linking.openURL(
                    'https://support.bitpay.com/hc/en-us/articles/41956465346061-Pausing-Bill-Pay-Services-on-2025-12-26',
                  )
                }>
                {' Learn more'}
              </AlertLink>
            </AlertText>
          </>
        ) : (
          <>
            <AlertHeader>No late fees</AlertHeader>
            <AlertText>
              Your bank will give you credit for making this payment within one
              business day, but it may take 3-7 business days for it to show up
              on your bank statement.
            </AlertText>
          </>
        )}
      </AlertBody>
    </AlertContainer>
  );
};
