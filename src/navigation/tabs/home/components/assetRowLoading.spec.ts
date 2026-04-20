import {getAssetRowPopulateLoading} from './assetRowLoading';

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
