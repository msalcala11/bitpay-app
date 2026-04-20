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
