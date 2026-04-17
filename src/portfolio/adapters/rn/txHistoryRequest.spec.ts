import {buildPortfolioTxHistoryRequestPath} from './txHistoryRequest';

describe('buildPortfolioTxHistoryRequestPath', () => {
  it('adds reverse=1 and multisig params for oldest-first paging', () => {
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
      '/v1/txhistory/?limit=1000&reverse=1&multisigContractAddress=0xSafe',
    );
  });

  it('does not append tokenAddress for token wallets', () => {
    const requestPath = buildPortfolioTxHistoryRequestPath({
      credentials: {
        token: {
          address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        },
      } as any,
      skip: 0,
      limit: 1000,
      reverse: true,
    });

    expect(requestPath).toBe('/v1/txhistory/?limit=1000&reverse=1');
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
