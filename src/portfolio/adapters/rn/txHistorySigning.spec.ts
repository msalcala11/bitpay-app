import {Buffer as NodeBuffer} from 'buffer';

const PROBE_EXPECTED_COMPRESSED_PUBLIC_KEY_HEX =
  '0299ff649f174b2e52fa14229c70fdb774d799922e08881cecfaa9feb9fef80d5b';
const PROBE_EXPECTED_X_HEX =
  '99ff649f174b2e52fa14229c70fdb774d799922e08881cecfaa9feb9fef80d5b';
const PROBE_EXPECTED_Y_HEX =
  '2590af56f2c727a48cf7be607ec1ce3f8d38a67143af2bbf5ab6b3c5b7dbe120';
const PROBE_EXPECTED_SPKI_HEX = [
  '3056301006072a8648ce3d020106052b8104000a03420004',
  PROBE_EXPECTED_X_HEX,
  PROBE_EXPECTED_Y_HEX,
].join('');

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

const mockNitroFetchClient = {
  request: jest.fn(),
  requestSync: jest.fn(),
};
const mockCreateClient = jest.fn(() => mockNitroFetchClient);
const mockNitroFetchSingleton = {
  createClient: mockCreateClient,
};
const mockNitroModulesBox = jest.fn((obj: unknown) => ({
  unbox: () => obj,
}));
const mockCreateHybridObject = jest.fn((name: string) => {
  switch (name) {
    case 'Hash':
      return {
        createHash: jest.fn(),
        update: jest.fn(),
        digest: jest.fn(() => new ArrayBuffer(32)),
      };
    case 'KeyObjectHandle':
      return {
        init: jest.fn(() => true),
        exportKey: jest.fn(() =>
          bufferToArrayBuffer(NodeBuffer.from(PROBE_EXPECTED_SPKI_HEX, 'hex')),
        ),
        exportJwk: jest.fn(() => ({
          kty: 'EC',
          crv: 'secp256k1',
          x: NodeBuffer.from(PROBE_EXPECTED_X_HEX, 'hex').toString('base64url'),
          y: NodeBuffer.from(PROBE_EXPECTED_Y_HEX, 'hex').toString('base64url'),
        })),
      };
    case 'SignHandle':
      return {
        init: jest.fn(),
        update: jest.fn(),
        sign: jest.fn(() => new Uint8Array([1, 2, 3]).buffer),
      };
    default:
      throw new Error(`Unexpected hybrid object request: ${name}`);
  }
});

jest.mock('react-native-nitro-modules', () => ({
  NitroModules: {
    createHybridObject: (...args: unknown[]) => mockCreateHybridObject(...args),
    box: (...args: unknown[]) => mockNitroModulesBox(...args),
  },
}));

jest.mock('react-native-nitro-fetch', () => ({
  NitroFetch: mockNitroFetchSingleton,
}));

jest.mock('react-native-quick-crypto', () => ({
  KeyType: {PRIVATE: 1},
  KFormatType: {DER: 2},
  KeyEncoding: {SPKI: 2, SEC1: 3},
}));

import {
  clearPortfolioTxHistorySigningDispatchContextOnRuntime,
  createPortfolioTxHistorySigningDispatchContextOnRN,
  getPortfolioNitroFetchClientOnRuntime,
  PORTFOLIO_REQUEST_KEY_DEBUG_PROBE_PRIVATE_KEY_HEX,
  probeQuickCryptoRequestPubKeyDerivationOnRN,
  requirePortfolioTxHistorySigningDispatchContextOnRuntime,
  setPortfolioTxHistorySigningDispatchContextOnRuntime,
  signBwsGetRequestWithBitcore,
  takeNextPortfolioTransferredSignHandleOnRuntime,
} from './txHistorySigning';

describe('signBwsGetRequestWithBitcore', () => {
  afterEach(() => {
    clearPortfolioTxHistorySigningDispatchContextOnRuntime();
    jest.clearAllMocks();
  });

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

  it('hydrates a lightweight runtime signing context on demand', () => {
    const lightweightContext = createPortfolioTxHistorySigningDispatchContextOnRN({
      requestPrivKey:
        '3da1b53f027ed856bb1922dde7438f91309a59fa1a3aaf7f64dd7f46a258c73c',
      requestCount: 2,
    });
    setPortfolioTxHistorySigningDispatchContextOnRuntime(lightweightContext);

    const context = requirePortfolioTxHistorySigningDispatchContextOnRuntime();

    expect(context.requestPrivKeySec1DerHex).toBeTruthy();
    expect(context.boxedNitroModulesProxy).toBeDefined();
    expect(context.boxedNitroFetch).toBeDefined();
    expect(context.signHandleHybrids).toHaveLength(2);
    expect(mockNitroModulesBox).toHaveBeenCalledWith(mockNitroFetchSingleton);
    expect(mockNitroModulesBox).toHaveBeenCalledTimes(2);
    expect(mockCreateHybridObject).toHaveBeenCalledTimes(4);

    const nitroFetchClient = getPortfolioNitroFetchClientOnRuntime();
    expect(nitroFetchClient).toBe(mockNitroFetchClient);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);

    const firstHandle = takeNextPortfolioTransferredSignHandleOnRuntime();
    const secondHandle = takeNextPortfolioTransferredSignHandleOnRuntime();

    expect(firstHandle).not.toBeNull();
    expect(secondHandle).not.toBeNull();
    expect(context.nextSignHandleIndex).toBe(2);
    expect(mockCreateHybridObject).toHaveBeenCalledTimes(4);
  });

  it('exports a Quick Crypto public key probe result for the fixed test vector', () => {
    const result = probeQuickCryptoRequestPubKeyDerivationOnRN();

    expect(PORTFOLIO_REQUEST_KEY_DEBUG_PROBE_PRIVATE_KEY_HEX).toBe(
      '3da1b53f027ed856bb1922dde7438f91309a59fa1a3aaf7f64dd7f46a258c73c',
    );
    expect(result.probeKeyTag).toBe('fixed_test_vector_v1');
    expect(result.requestPrivKeySec1DerHex).toBeTruthy();
    expect(result.publicKeySpkiHex).toBe(PROBE_EXPECTED_SPKI_HEX);
    expect(result.publicJwk).toMatchObject({
      kty: 'EC',
      crv: 'secp256k1',
    });
    expect(result.publicKeyXHex).toBe(PROBE_EXPECTED_X_HEX);
    expect(result.publicKeyYHex).toBe(PROBE_EXPECTED_Y_HEX);
    expect(result.compressedPublicKeyHex).toBe(
      PROBE_EXPECTED_COMPRESSED_PUBLIC_KEY_HEX,
    );
    expect(result.uncompressedPublicKeyHex).toBe(
      `04${PROBE_EXPECTED_X_HEX}${PROBE_EXPECTED_Y_HEX}`,
    );
  });
});
