import React, {useMemo} from 'react';
import styled, {useTheme} from 'styled-components/native';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import {useNavigation} from '@react-navigation/native';
import Svg, {Circle, G} from 'react-native-svg';
import {ActiveOpacity, ScreenGutter} from '../../../../components/styled/Containers';
import {BaseText} from '../../../../components/styled/Text';
import {HomeSectionTitle} from './Styled';
import ChevronRightSvg from './ChevronRightSvg';
import {useAppDispatch, useAppSelector} from '../../../../utils/hooks';
import {buildUIFormattedWallet} from '../../../../store/wallet/utils/wallet';
import type {WalletRowProps} from '../../../../components/list/WalletRow';
import type {Key, Wallet} from '../../../../store/wallet/wallet.models';
import {buildAllocationDataFromWalletRows} from '../utils/allocationData';
import {
  Black,
  Slate30,
  SlateDark,
  White,
} from '../../../../styles/colors';

export type AllocationLegendItem = {
  key: string;
  label: string;
  value?: string;
  color: {
    light: string;
    dark: string;
  };
};

export type AllocationSlice = {
  key: string;
  value: number;
  color: {
    light: string;
    dark: string;
  };
};

const Container = styled.View`margin-bottom: 15px;`;

const Header = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  margin: 0 ${ScreenGutter} 0 16px;
`;

const HeaderAction = styled(TouchableOpacity)`
  padding: 6px;
`;

const Card = styled.View`
  margin: 12px ${ScreenGutter} 10px;
  border-radius: 12px;
  border-width: 1px;
  border-color: ${({theme: {dark}}) => (dark ? SlateDark : Slate30)};
  background-color: ${({theme: {dark}}) => (dark ? 'transparent' : White)};
  padding: 14px 14px;
`;

const ContentRow = styled.View`
  flex-direction: row;
  align-items: center;
`;

const DonutContainer = styled.View`
  width: 88px;
  height: 88px;
  align-items: center;
  justify-content: center;
  margin-right: 14px;
`;

const LegendGrid = styled.View`
  flex: 1;
  flex-direction: row;
  justify-content: space-between;
`;

const LegendColumn = styled.View`
  flex: 1;
  gap: 10px;
`;

const LegendItemRow = styled.View`
  flex-direction: row;
  align-items: center;
`;

const LegendDot = styled.View<{
  color: string;
}>`
  width: 9px;
  height: 9px;
  border-radius: 8px;
  margin-right: 8px;
  background-color: ${({color}) => color};
  border-width: 1px;
  border-color: ${({theme: {dark}}) => (dark ? SlateDark : Slate30)};
`;

const LegendText = styled(BaseText)`
  font-size: 13px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
`;

const LegendCurrencyAbbreviationText = styled(LegendText)`
  color: ${({theme: {dark}}) => (dark ? White : Black)};
`;

const LegendPercentageText = styled(LegendText)`
  color: ${({theme: {dark}}) => (dark ? Slate30 : SlateDark)};
`;

const DonutChart = ({
  size,
  strokeWidth,
  slices,
}: {
  size: number;
  strokeWidth: number;
  slices: AllocationSlice[];
}) => {
  const theme = useTheme();
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const segmentBorderColor = theme.dark ? SlateDark : Slate30;

  const gap = 2;
  let cumulativeLength = 0;

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <G rotation={-90} originX={size / 2} originY={size / 2}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={segmentBorderColor}
          strokeWidth={strokeWidth}
          fill="transparent"
        />
        {slices.map(slice => {
          const color = theme.dark ? slice.color.dark : slice.color.light;
          const segmentLength = (slice.value / total) * circumference;
          const adjustedSegmentLength = Math.max(0, segmentLength - gap);
          const dashArray = `${adjustedSegmentLength} ${circumference}`;
          const dashOffset = -(cumulativeLength + gap / 2);
          cumulativeLength += segmentLength;

          return (
            <Circle
              key={slice.key}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke={color}
              strokeWidth={strokeWidth}
              strokeDasharray={dashArray}
              strokeDashoffset={dashOffset}
              strokeLinecap="butt"
              fill="transparent"
            />
          );
        })}
      </G>
    </Svg>
  );
};

export const AllocationDonutLegendCard: React.FC<{
  legendItems: AllocationLegendItem[];
  slices: AllocationSlice[];
  style?: any;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}> = ({legendItems, slices, style, header, footer}) => {
  const theme = useTheme();
  const leftColumn = legendItems.slice(0, 3);
  const rightColumn = legendItems.slice(3);

  return (
    <Card style={style}>
      {header}
      <ContentRow>
        <DonutContainer>
          <DonutChart size={80} strokeWidth={12} slices={slices} />
        </DonutContainer>

        <LegendGrid>
          <LegendColumn>
            {leftColumn.map(item => {
              const dotColor = theme.dark ? item.color.dark : item.color.light;

              return (
                <LegendItemRow key={item.key}>
                  <LegendDot color={dotColor} />
                  <LegendText>
                    <LegendCurrencyAbbreviationText>
                      {item.label}
                    </LegendCurrencyAbbreviationText>
                    {item.value ? (
                      <LegendPercentageText>{` ${item.value}`}</LegendPercentageText>
                    ) : null}
                  </LegendText>
                </LegendItemRow>
              );
            })}
          </LegendColumn>

          <LegendColumn>
            {rightColumn.map(item => {
              const dotColor = theme.dark ? item.color.dark : item.color.light;

              return (
                <LegendItemRow key={item.key}>
                  <LegendDot color={dotColor} />
                  <LegendText>
                    <LegendCurrencyAbbreviationText>
                      {item.label}
                    </LegendCurrencyAbbreviationText>
                    {item.value ? (
                      <LegendPercentageText>{` ${item.value}`}</LegendPercentageText>
                    ) : null}
                  </LegendText>
                </LegendItemRow>
              );
            })}
          </LegendColumn>
        </LegendGrid>
      </ContentRow>
      {footer}
    </Card>
  );
};

const AllocationSection: React.FC = () => {
  const navigation = useNavigation();
  const dispatch = useAppDispatch();
  const keys = useAppSelector(({WALLET}) => WALLET.keys) as Record<string, Key>;
  const {rates} = useAppSelector(({RATE}) => RATE);
  const {defaultAltCurrency} = useAppSelector(({APP}) => APP);

  const walletRows: WalletRowProps[] = useMemo(() => {
    const wallets = (Object.values(keys) as Key[])
      .flatMap((k: Key) => k.wallets)
      .filter((w: Wallet) => !w.hideWallet && !w.hideWalletByAccount);

    return wallets.map((w: Wallet) =>
      buildUIFormattedWallet(w, defaultAltCurrency.isoCode, rates, dispatch, 'symbol'),
    );
  }, [defaultAltCurrency.isoCode, dispatch, keys, rates]);

  const allocationData = useMemo(() => {
    return buildAllocationDataFromWalletRows(walletRows, defaultAltCurrency.isoCode);
  }, [defaultAltCurrency.isoCode, walletRows]);

  return (
    <Container>
      <Header>
        <HomeSectionTitle>Allocation</HomeSectionTitle>
        <HeaderAction
          activeOpacity={ActiveOpacity}
          onPress={() => (navigation as any).navigate('Allocation')}>
          <ChevronRightSvg width={13} height={19} gray />
        </HeaderAction>
      </Header>

      <TouchableOpacity
        activeOpacity={ActiveOpacity}
        onPress={() => (navigation as any).navigate('Allocation')}>
        <AllocationDonutLegendCard
          legendItems={allocationData.legendItems}
          slices={allocationData.slices}
        />
      </TouchableOpacity>
    </Container>
  );
};

export default AllocationSection;
