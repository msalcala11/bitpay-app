import React from 'react';
import SkeletonPlaceholder from 'react-native-skeleton-placeholder';
import styled, {useTheme} from 'styled-components/native';
import {ScreenGutter} from '../../../../components/styled/Containers';
import AssetRow from './AssetRow';
import {AssetRowItem} from '../../../../utils/portfolio/assets';
import {useAssetIconResolver} from '../hooks/useAssetIconResolver';
import {
  CharcoalBlack,
  GhostWhite,
  LightBlack,
  LightBlue,
  NeutralSlate,
} from '../../../../styles/colors';

export const ASSETS_LIST_SKELETON_ROW_COUNT = 4;

const List = styled.View`
  margin: 10px ${ScreenGutter} 10px;
`;

const SkeletonRow = styled.View<{isLast: boolean}>`
  padding: 14px 0;
  border-bottom-width: ${({isLast}) => (isLast ? 0 : 1)}px;
  border-bottom-color: ${({theme: {dark}}) => (dark ? LightBlack : LightBlue)};
`;

interface AssetsListSkeletonRowsProps {
  count?: number;
}

export const AssetsListSkeletonRows: React.FC<
  AssetsListSkeletonRowsProps
> = ({count = ASSETS_LIST_SKELETON_ROW_COUNT}) => {
  const theme = useTheme();
  const rowCount = Math.max(0, count);

  return (
    <>
      {Array.from({length: rowCount}).map((_, index) => (
        <SkeletonRow
          key={`asset-list-skeleton-row-${index}`}
          isLast={index === rowCount - 1}
          testID={`home-asset-row-skeleton-${index}`}>
          <SkeletonPlaceholder
            backgroundColor={theme.dark ? CharcoalBlack : NeutralSlate}
            highlightColor={theme.dark ? LightBlack : GhostWhite}>
            <SkeletonPlaceholder.Item flexDirection="row" alignItems="center">
              <SkeletonPlaceholder.Item
                width={40}
                height={40}
                borderRadius={20}
                marginRight={12}
              />

              <SkeletonPlaceholder.Item flex={1}>
                <SkeletonPlaceholder.Item
                  width={112}
                  height={12}
                  borderRadius={2}
                  marginBottom={8}
                />
                <SkeletonPlaceholder.Item
                  width={80}
                  height={12}
                  borderRadius={2}
                />
              </SkeletonPlaceholder.Item>

              <SkeletonPlaceholder.Item alignItems="flex-end" marginRight={12}>
                <SkeletonPlaceholder.Item
                  width={72}
                  height={12}
                  borderRadius={2}
                  marginBottom={8}
                />
                <SkeletonPlaceholder.Item
                  width={54}
                  height={12}
                  borderRadius={2}
                />
              </SkeletonPlaceholder.Item>

              <SkeletonPlaceholder.Item
                width={58}
                height={36}
                borderRadius={18}
                marginRight={23}
              />
            </SkeletonPlaceholder.Item>
          </SkeletonPlaceholder>
        </SkeletonRow>
      ))}
    </>
  );
};

interface Props {
  items: AssetRowItem[];
  isFiatLoading?: boolean;
  isPnlLoading?: boolean;
  populateInProgress?: boolean;
  isPopulateLoadingByKey?: Record<string, boolean>;
  showSkeletonRows?: boolean;
  skeletonRowCount?: number;
}

const AssetsList: React.FC<Props> = ({
  items,
  isFiatLoading,
  isPnlLoading,
  populateInProgress,
  isPopulateLoadingByKey,
  showSkeletonRows,
  skeletonRowCount,
}) => {
  const {getAssetIconData} = useAssetIconResolver();

  return (
    <List>
      {showSkeletonRows ? (
        <AssetsListSkeletonRows count={skeletonRowCount} />
      ) : (
        items.map((item, index) => {
          const {img, imgSrc} = getAssetIconData(item);

          const isRowPopulateLoading =
            isPopulateLoadingByKey?.[item.key] ?? !!populateInProgress;

          return (
            <AssetRow
              key={item.key}
              item={item}
              isLast={index === items.length - 1}
              isFiatLoading={isFiatLoading}
              isPopulateLoading={isRowPopulateLoading}
              isPnlLoading={isPnlLoading}
              img={img}
              imgSrc={imgSrc}
            />
          );
        })
      )}
    </List>
  );
};

export default AssetsList;
