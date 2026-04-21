import type {AssetRowItem} from '../../../../utils/portfolio/assets';

export function getAssetRowPopulateLoading(args: {
  populateInProgress?: boolean;
  showPnlPlaceholder?: boolean;
  rowLoadingByKey?: Record<string, boolean>;
  rowKey: string;
}): boolean {
  if (args.populateInProgress && args.showPnlPlaceholder) {
    return true;
  }

  return args.rowLoadingByKey?.[args.rowKey] ?? !!args.populateInProgress;
}

export function getAssetRowFiatLoading(args: {
  populateInProgress?: boolean;
  isFiatLoading?: boolean;
  isRowPopulateLoading?: boolean;
  showScopedPnlLoading?: boolean;
}): boolean {
  return (
    (!!args.isFiatLoading && !!args.isRowPopulateLoading) ||
    (!args.populateInProgress && !!args.showScopedPnlLoading)
  );
}

export function resolveAssetRowDisplayPresentation(args: {
  item: AssetRowItem;
  preservedItem?: AssetRowItem;
  isLoading: boolean;
  loadingDelayElapsed: boolean;
}): {
  displayItem: AssetRowItem;
  shouldShowSkeleton: boolean;
  usingPreservedItem: boolean;
} {
  const hasPreservedItem = !!args.preservedItem;
  const usingPreservedItem =
    args.isLoading && hasPreservedItem && !args.loadingDelayElapsed;

  return {
    displayItem: usingPreservedItem ? (args.preservedItem as AssetRowItem) : args.item,
    shouldShowSkeleton:
      args.isLoading && (!hasPreservedItem || args.loadingDelayElapsed),
    usingPreservedItem,
  };
}
