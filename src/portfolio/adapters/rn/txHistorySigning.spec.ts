import {Buffer as NodeBuffer} from 'buffer';

import {signBwsGetRequestWithBitcore} from './txHistorySigning';

describe('signBwsGetRequestWithBitcore', () => {
  it('matches the BWC/bitcore signature for a txhistory GET path', () => {
    const requestPath = '/v1/txhistory/?limit=1000&reverse=1&r=75511';
    const requestPrivKey =
      '3da1b53f027ed856bb1922dde7438f91309a59fa1a3aaf7f64dd7f46a258c73c';
    const bitcoreLib = require('@bitpay-labs/bitcore-lib') as any;
    const rawHash = bitcoreLib.crypto.Hash.sha256sha256(
      NodeBuffer.from(`get|${requestPath}|{}`),
    );
    const hash = new bitcoreLib.encoding.BufferReader(rawHash).readReverse();
    const expected = bitcoreLib.crypto.ECDSA.sign(
      hash,
      new bitcoreLib.PrivateKey(requestPrivKey),
      {endian: 'little'},
    ).toString();

    expect(signBwsGetRequestWithBitcore(requestPath, requestPrivKey)).toBe(
      expected,
    );
  });
});
