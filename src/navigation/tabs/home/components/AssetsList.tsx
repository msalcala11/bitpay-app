import React, {useMemo} from 'react';
import styled from 'styled-components/native';
import {ScreenGutter} from '../../../../components/styled/Containers';
import AssetRow from './AssetRow';
import {AssetRowItem} from '../../../../utils/portfolio/assets';
import {
  useDevLayoutTrace,
  useDevRenderTrace,
} from '../../../../utils/hooks/useDevRenderTrace';
import {useAssetIconResolver} from '../hooks/useAssetIconResolver';
import {
  getAssetRowFiatLoading,
  getAssetRowPopulateLoading,
  shouldForceAssetListSkeleton,
} from './assetRowLoading';

const List = styled.View`
  margin: 10px ${ScreenGutter} 10px;
`;

interface Props {
  items: AssetRowItem[];
  isFiatLoading?: boolean;
  populateInProgress?: boolean;
  isPopulateLoadingByKey?: Record<string, boolean>;
  forceSkeleton?: boolean;
}

const AssetsList: React.FC<Props> = ({
  items,
  isFiatLoading,
  populateInProgress,
  isPopulateLoadingByKey,
  forceSkeleton,
}) => {
  const {getAssetIconData} = useAssetIconResolver();
  const shouldForceSkeletonMode = useMemo(() => {
    return shouldForceAssetListSkeleton({
      items,
      forceSkeleton,
      isFiatLoading,
    });
  }, [forceSkeleton, isFiatLoading, items]);
  const rowLoadingCounts = useMemo(() => {
    let populateLoadingCount = 0;
    let fiatLoadingCount = 0;

    for (const item of items) {
      const isRowPopulateLoading = getAssetRowPopulateLoading({
        populateInProgress,
        showPnlPlaceholder: item.showPnlPlaceholder,
        rowLoadingByKey: isPopulateLoadingByKey,
        rowKey: item.key,
      });
      const isRowFiatLoading = getAssetRowFiatLoading({
        populateInProgress,
        isFiatLoading,
        isRowPopulateLoading,
        showScopedPnlLoading: !!item.showScopedPnlLoading,
      });

      if (isRowPopulateLoading) {
        populateLoadingCount += 1;
      }
      if (isRowFiatLoading) {
        fiatLoadingCount += 1;
      }
    }

    return {
      populateLoadingCount,
      fiatLoadingCount,
    };
  }, [isFiatLoading, isPopulateLoadingByKey, items, populateInProgress]);
  const assetsListOnLayout = useDevLayoutTrace('HomeAssetsListLayout');

  useDevRenderTrace('AssetsList', {
    itemCount: items.length,
    rowPopulateLoadingCount: rowLoadingCounts.populateLoadingCount,
    rowFiatLoadingCount: rowLoadingCounts.fiatLoadingCount,
    forceSkeleton: shouldForceSkeletonMode,
    isFiatLoading: !!isFiatLoading,
    populateInProgress: !!populateInProgress,
  });

  return (
    <List onLayout={assetsListOnLayout}>
      {items.map((item, index) => {
        const {img, imgSrc} = getAssetIconData(item);
        const isRowPopulateLoading = getAssetRowPopulateLoading({
          populateInProgress,
          showPnlPlaceholder: item.showPnlPlaceholder,
          rowLoadingByKey: isPopulateLoadingByKey,
          rowKey: item.key,
        });
        const isRowScopedPnlLoading = !!item.showScopedPnlLoading;
        const isRowFiatLoading = getAssetRowFiatLoading({
          populateInProgress,
          isFiatLoading,
          isRowPopulateLoading,
          showScopedPnlLoading: isRowScopedPnlLoading,
        });

        return (
          <AssetRow
            key={item.key}
            item={item}
            isLast={index === items.length - 1}
            isFiatLoading={isRowFiatLoading}
            isPopulateLoading={isRowPopulateLoading}
            forceSkeleton={shouldForceSkeletonMode}
            img={img}
            imgSrc={imgSrc}
          />
        );
      })}
    </List>
  );
};

export default AssetsList;
