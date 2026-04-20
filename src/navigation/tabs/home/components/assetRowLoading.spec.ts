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
        populateInProgress: true,
        isFiatLoading: true,
        isRowPopulateLoading: true,
        showScopedPnlLoading: false,
      }),
    ).toBe(true);
  });

  it('does not keep fiat loading active during populate when only scoped pnl loading is pending', () => {
    expect(
      getAssetRowFiatLoading({
        populateInProgress: true,
        isFiatLoading: false,
        isRowPopulateLoading: false,
        showScopedPnlLoading: true,
      }),
    ).toBe(false);
  });

  it('shows fiat loading after populate completes when scoped pnl loading is pending', () => {
    expect(
      getAssetRowFiatLoading({
        populateInProgress: false,
        isFiatLoading: false,
        isRowPopulateLoading: false,
        showScopedPnlLoading: true,
      }),
    ).toBe(true);
  });

  it('does not show fiat loading when neither populate nor scoped loading is active', () => {
    expect(
      getAssetRowFiatLoading({
        populateInProgress: false,
        isFiatLoading: true,
        isRowPopulateLoading: false,
        showScopedPnlLoading: false,
      }),
    ).toBe(false);
  });
});
