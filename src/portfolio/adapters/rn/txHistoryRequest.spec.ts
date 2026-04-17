import {buildPortfolioTxHistoryRequestPath} from './txHistoryRequest';

describe('buildPortfolioTxHistoryRequestPath', () => {
  it('adds reverse=1 plus token and multisig params for oldest-first paging', () => {
    const requestPath = buildPortfolioTxHistoryRequestPath({
      credentials: {
        token: {address: '0xToken'},
        multisigEthInfo: {multisigContractAddress: '0xSafe'},
      },
      skip: 0,
      limit: 1000,
      reverse: true,
    });

    expect(requestPath).toBe(
      '/v1/txhistory/?limit=1000&reverse=1&tokenAddress=0xToken&multisigContractAddress=0xSafe',
    );
  });

  it('omits reverse when newest-first paging is requested', () => {
    const requestPath = buildPortfolioTxHistoryRequestPath({
      credentials: {},
      skip: 25,
      limit: 200,
      reverse: false,
    });

    expect(requestPath).toBe('/v1/txhistory/?skip=25&limit=200');
  });
});
