import React, {useMemo} from 'react';
import styled, {useTheme} from 'styled-components/native';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import Svg, {Circle, G} from 'react-native-svg';
import {ActiveOpacity, ScreenGutter} from '../../../../components/styled/Containers';
import {BaseText} from '../../../../components/styled/Text';
import {HomeSectionTitle} from './Styled';
import ChevronRightSvg from './ChevronRightSvg';
import {LightBlack, Slate, Slate30, SlateDark, White} from '../../../../styles/colors';

type AllocationLegendItem = {
  key: string;
  label: string;
  value?: string;
  color: {
    light: string;
    dark: string;
  };
  outlinedDot?: boolean;
};

type AllocationSlice = {
  key: string;
  value: number;
  color: {
    light: string;
    dark: string;
  };
};

const Container = styled.View``;

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
  outlined?: boolean;
  outlineColor: string;
}>`
  width: 8px;
  height: 8px;
  border-radius: 8px;
  margin-right: 10px;
  background-color: ${({outlined, color}) => (outlined ? 'transparent' : color)};
  border-width: ${({outlined}) => (outlined ? 1 : 0)}px;
  border-color: ${({outlineColor}) => outlineColor};
`;

const LegendText = styled(BaseText)`
  font-size: 14px;
  font-weight: 500;
  color: ${({theme}) => theme.colors.text};
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

  let cumulative = 0;

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <G rotation={-90} originX={size / 2} originY={size / 2}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={theme.dark ? LightBlack : Slate30}
          strokeWidth={strokeWidth}
          fill="transparent"
        />
        {slices.map(slice => {
          const color = theme.dark ? slice.color.dark : slice.color.light;
          const segment = (slice.value / total) * circumference;
          const dashArray = `${segment} ${circumference}`;
          const dashOffset = -(cumulative / total) * circumference;
          cumulative += slice.value;

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

const AllocationSection: React.FC = () => {
  const theme = useTheme();

  const legendItems: AllocationLegendItem[] = useMemo(
    () => [
      {
        key: 'btc',
        label: 'BTC',
        value: '53.4%',
        color: {light: '#F7931A', dark: '#F7931A'},
      },
      {
        key: 'eth',
        label: 'ETH',
        value: '32.1%',
        color: {light: '#627EEA', dark: '#627EEA'},
      },
      {
        key: 'usdc',
        label: 'USDC',
        value: '8.3%',
        color: {light: '#2775CA', dark: '#2775CA'},
      },
      {
        key: 'xrp',
        label: 'XRP',
        value: '9.8%',
        color: {light: '#000000', dark: SlateDark},
        outlinedDot: true,
      },
      {
        key: 'sol',
        label: 'SOL',
        value: '19.8%',
        color: {light: '#7C3AED', dark: '#7C3AED'},
      },
      {
        key: 'other',
        label: 'Other',
        color: {light: Slate, dark: SlateDark},
      },
    ],
    [],
  );

  const slices: AllocationSlice[] = useMemo(
    () => [
      {key: 'btc', value: 53.4, color: {light: '#F7931A', dark: '#F7931A'}},
      {key: 'eth', value: 32.1, color: {light: '#627EEA', dark: '#627EEA'}},
      {key: 'sol', value: 19.8, color: {light: '#7C3AED', dark: '#7C3AED'}},
      {key: 'usdc', value: 8.3, color: {light: '#2775CA', dark: '#2775CA'}},
      {key: 'xrp', value: 9.8, color: {light: '#000000', dark: SlateDark}},
      {key: 'other', value: 6.6, color: {light: Slate, dark: SlateDark}},
    ],
    [],
  );

  const leftColumn = legendItems.slice(0, 3);
  const rightColumn = legendItems.slice(3);

  return (
    <Container>
      <Header>
        <HomeSectionTitle>Allocation</HomeSectionTitle>
        <HeaderAction activeOpacity={ActiveOpacity} onPress={() => {}}>
          <ChevronRightSvg width={9} height={15} gray />
        </HeaderAction>
      </Header>

      <Card>
        <ContentRow>
          <DonutContainer>
            <DonutChart size={80} strokeWidth={12} slices={slices} />
          </DonutContainer>

          <LegendGrid>
            <LegendColumn>
              {leftColumn.map(item => {
                const dotColor = theme.dark ? item.color.dark : item.color.light;
                const outlineColor = theme.dark
                  ? Slate
                  : item.key === 'xrp'
                    ? '#000000'
                    : dotColor;
                const text = item.value ? `${item.label} ${item.value}` : item.label;

                return (
                  <LegendItemRow key={item.key}>
                    <LegendDot
                      color={dotColor}
                      outlined={item.outlinedDot}
                      outlineColor={outlineColor}
                    />
                    <LegendText>{text}</LegendText>
                  </LegendItemRow>
                );
              })}
            </LegendColumn>

            <LegendColumn>
              {rightColumn.map(item => {
                const dotColor = theme.dark ? item.color.dark : item.color.light;
                const outlineColor = theme.dark
                  ? Slate
                  : item.key === 'xrp'
                    ? '#000000'
                    : dotColor;
                const text = item.value ? `${item.label} ${item.value}` : item.label;

                return (
                  <LegendItemRow key={item.key}>
                    <LegendDot
                      color={dotColor}
                      outlined={item.outlinedDot}
                      outlineColor={outlineColor}
                    />
                    <LegendText>{text}</LegendText>
                  </LegendItemRow>
                );
              })}
            </LegendColumn>
          </LegendGrid>
        </ContentRow>
      </Card>
    </Container>
  );
};

export default AllocationSection;
