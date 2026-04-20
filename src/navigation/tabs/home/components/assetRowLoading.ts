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
