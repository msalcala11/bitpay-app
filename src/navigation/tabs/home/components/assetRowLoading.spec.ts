import {
  getAssetRowFiatLoading,
  getAssetRowPopulateLoading,
} from './assetRowLoading';

describe('getAssetRowPopulateLoading', () => {
  it('forces loading for placeholder rows during populate even if row loading says false', () => {
    expect(
      getAssetRowPopulateLoading({
        populateInProgress: true,
        showPnlPlaceholder: true,
        rowLoadingByKey: {btc: false},
        rowKey: 'btc',
      }),
    ).toBe(true);
  });

  it('falls back to explicit row loading when the row is not a placeholder', () => {
    expect(
      getAssetRowPopulateLoading({
        populateInProgress: true,
        showPnlPlaceholder: false,
        rowLoadingByKey: {btc: false},
        rowKey: 'btc',
      }),
    ).toBe(false);
  });

  it('falls back to populate state when no row-specific loading is available', () => {
    expect(
      getAssetRowPopulateLoading({
        populateInProgress: true,
        showPnlPlaceholder: false,
        rowKey: 'btc',
      }),
    ).toBe(true);
  });
});

describe('getAssetRowFiatLoading', () => {
  it('shows fiat loading when fiat loading and populate loading are both active', () => {
    expect(
      getAssetRowFiatLoading({
        isFiatLoading: true,
        isRowPopulateLoading: true,
        showScopedPnlLoading: false,
      }),
    ).toBe(true);
  });

  it('shows fiat loading when scoped pnl loading is active even without populate loading', () => {
    expect(
      getAssetRowFiatLoading({
        isFiatLoading: false,
        isRowPopulateLoading: false,
        showScopedPnlLoading: true,
      }),
    ).toBe(true);
  });

  it('does not show fiat loading when neither populate nor scoped loading is active', () => {
    expect(
      getAssetRowFiatLoading({
        isFiatLoading: true,
        isRowPopulateLoading: false,
        showScopedPnlLoading: false,
      }),
    ).toBe(false);
  });
});
