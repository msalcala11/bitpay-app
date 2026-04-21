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
} from './assetRowLoading';

const List = styled.View`
  margin: 10px ${ScreenGutter} 10px;
`;

interface Props {
  items: AssetRowItem[];
  isFiatLoading?: boolean;
  populateInProgress?: boolean;
  isPopulateLoadingByKey?: Record<string, boolean>;
}

const AssetsList: React.FC<Props> = ({
  items,
  isFiatLoading,
  populateInProgress,
  isPopulateLoadingByKey,
}) => {
  const {getAssetIconData} = useAssetIconResolver();
  const itemSignature = useMemo(() => {
    return items
      .map(
        item =>
          `${item.key}:${item.fiatAmount}:${item.deltaFiat}:${item.deltaPercent}:${item.showScopedPnlLoading ? '1' : '0'}:${item.showPnlPlaceholder ? '1' : '0'}`,
      )
      .join('|');
  }, [items]);
  const rowLoadingSignature = useMemo(() => {
    return items
      .map(item => {
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

        return `${item.key}:${isRowPopulateLoading ? '1' : '0'}:${isRowFiatLoading ? '1' : '0'}`;
      })
      .join('|');
  }, [isFiatLoading, isPopulateLoadingByKey, items, populateInProgress]);
  const assetsListOnLayout = useDevLayoutTrace('HomeAssetsListLayout');

  useDevRenderTrace('AssetsList', {
    itemCount: items.length,
    itemSignature,
    rowLoadingSignature,
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
            img={img}
            imgSrc={imgSrc}
          />
        );
      })}
    </List>
  );
};

export default AssetsList;
