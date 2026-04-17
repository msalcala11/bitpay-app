import {Buffer as NodeBuffer} from 'buffer';
import processPolyfill from 'process';

export type QuickCryptoHashHybrid = {
  createHash(algorithm: string, outputLength?: number): void;
  update(data: ArrayBuffer | string): void;
  digest(encoding?: string): ArrayBuffer;
};

export type QuickCryptoKeyObjectHybrid = {
  init(
    keyType: number,
    key: string | ArrayBuffer,
    format?: number,
    type?: number,
    passphrase?: ArrayBuffer,
  ): boolean;
};

export type QuickCryptoSignHybrid = {
  init(algorithm: string): void;
  update(data: ArrayBuffer): void;
  sign(
    keyHandle: QuickCryptoKeyObjectHybrid,
    padding?: number,
    saltLength?: number,
    dsaEncoding?: number,
  ): ArrayBuffer;
};

export type QuickCryptoEnums = {
  KeyType: {
    PRIVATE: number;
  };
  KFormatType: {
    DER: number;
  };
  KeyEncoding: {
    SEC1: number;
  };
};

type NitroModulesLike = {
  createHybridObject<T = unknown>(name: string): T;
};

export type TransferredNitroBwsSigningBatchHybrids = {
  firstHash: QuickCryptoHashHybrid;
  signHandles: QuickCryptoSignHybrid[];
  privateKeyHandle: QuickCryptoKeyObjectHybrid;
};

export type PortfolioTxHistorySigningDispatchContext = {
  requestPrivKey: string;
  firstHashHybrid?: QuickCryptoHashHybrid;
  signHandleHybrids?: QuickCryptoSignHybrid[];
  privateKeyHandle?: QuickCryptoKeyObjectHybrid;
  nextSignHandleIndex?: number;
};

type GlobalWithPortfolioSigningContext = typeof globalThis & {
  __bitpayPortfolioTxHistorySigningContextV1__?:
    | PortfolioTxHistorySigningDispatchContext
    | null;
};

const PORTFOLIO_TX_HISTORY_SIGNING_CONTEXT_GLOBAL_KEY =
  '__bitpayPortfolioTxHistorySigningContextV1__';

function getBitcoreLibForRuntime(): any {
  'worklet';

  const importedBitcoreLib = require('@bitpay-labs/bitcore-lib') as any;
  return importedBitcoreLib?.default || importedBitcoreLib;
}

function getBitcoreLibOnRN(): any {
  const importedBitcoreLib = require('@bitpay-labs/bitcore-lib') as any;
  return importedBitcoreLib?.default || importedBitcoreLib;
}

function getNitroModulesForRN(): NitroModulesLike {
  const importedNitroModules = require('react-native-nitro-modules') as any;
  const nitroModules =
    importedNitroModules?.NitroModules ||
    importedNitroModules?.default?.NitroModules;

  if (typeof nitroModules?.createHybridObject !== 'function') {
    throw new Error(
      'react-native-nitro-modules.NitroModules.createHybridObject() is unavailable on the RN runtime.',
    );
  }

  return nitroModules as NitroModulesLike;
}

function createQuickCryptoHashHybridOnRN(): QuickCryptoHashHybrid {
  return getNitroModulesForRN().createHybridObject<QuickCryptoHashHybrid>(
    'Hash',
  );
}

function createQuickCryptoKeyObjectHybridOnRN(): QuickCryptoKeyObjectHybrid {
  return getNitroModulesForRN().createHybridObject<QuickCryptoKeyObjectHybrid>(
    'KeyObjectHandle',
  );
}

function createQuickCryptoSignHybridOnRN(): QuickCryptoSignHybrid {
  return getNitroModulesForRN().createHybridObject<QuickCryptoSignHybrid>(
    'SignHandle',
  );
}

function getQuickCryptoEnumsForRN(): QuickCryptoEnums {
  const quickCrypto = require('react-native-quick-crypto') as any;

  if (
    typeof quickCrypto?.KeyType?.PRIVATE !== 'number' ||
    typeof quickCrypto?.KFormatType?.DER !== 'number' ||
    typeof quickCrypto?.KeyEncoding?.SEC1 !== 'number'
  ) {
    throw new Error(
      'react-native-quick-crypto key import enums are unavailable on the RN runtime.',
    );
  }

  return quickCrypto as QuickCryptoEnums;
}

function nodeBufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  'worklet';

  const view = Uint8Array.from(buffer);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function buildSecp256k1Sec1PrivateKeyDer(privateKeyBytes: Buffer): Buffer {
  if (privateKeyBytes.length !== 32) {
    throw new Error(
      `Expected a 32-byte secp256k1 private key, received ${privateKeyBytes.length} bytes.`,
    );
  }

  return NodeBuffer.concat([
    NodeBuffer.from([0x30, 0x2e, 0x02, 0x01, 0x01, 0x04, 0x20]),
    privateKeyBytes,
    NodeBuffer.from([0xa0, 0x07, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a]),
  ]);
}

export function ensurePortfolioRuntimeSigningGlobals(): void {
  'worklet';

  const globalRef = globalThis as any;

  if (!globalRef.global) {
    globalRef.global = globalRef;
  }
  if (!globalRef.self) {
    globalRef.self = globalRef;
  }
  if (!globalRef.window) {
    globalRef.window = globalRef;
  }
  if (!globalRef.Buffer) {
    globalRef.Buffer = NodeBuffer;
  }
  if (!globalRef.process) {
    globalRef.process = processPolyfill;
  }

  const processRef = globalRef.process as typeof processPolyfill;
  if (typeof processRef.browser === 'undefined') {
    processRef.browser = true;
  }
}

export function createTransferredNitroBwsSigningBatchOnRN(
  requestPrivKey: string,
  requestCount: number,
): TransferredNitroBwsSigningBatchHybrids {
  const bitcoreLib = getBitcoreLibOnRN();
  const {KeyType, KFormatType, KeyEncoding} = getQuickCryptoEnumsForRN();
  const privateKey = new bitcoreLib.PrivateKey(requestPrivKey);
  const privateKeyBytes = NodeBuffer.from(privateKey.toBuffer());
  const sec1Der = buildSecp256k1Sec1PrivateKeyDer(privateKeyBytes);

  const firstHash = createQuickCryptoHashHybridOnRN();
  const privateKeyHandle = createQuickCryptoKeyObjectHybridOnRN();
  const signHandles: QuickCryptoSignHybrid[] = [];

  const initialized = privateKeyHandle.init(
    KeyType.PRIVATE,
    nodeBufferToArrayBuffer(sec1Der),
    KFormatType.DER,
    KeyEncoding.SEC1,
  );

  if (!initialized) {
    throw new Error(
      'QuickCrypto KeyObjectHandle.init() returned false for the secp256k1 request key.',
    );
  }

  while (signHandles.length < Math.max(1, Math.floor(requestCount))) {
    signHandles.push(createQuickCryptoSignHybridOnRN());
  }

  return {
    firstHash,
    signHandles,
    privateKeyHandle,
  };
}

export function createPortfolioTxHistorySigningDispatchContextOnRN(args: {
  requestPrivKey: string;
  requestCount?: number;
}): PortfolioTxHistorySigningDispatchContext {
  const hybrids = createTransferredNitroBwsSigningBatchOnRN(
    args.requestPrivKey,
    args.requestCount ?? 4,
  );

  return {
    requestPrivKey: args.requestPrivKey,
    firstHashHybrid: hybrids.firstHash,
    signHandleHybrids: hybrids.signHandles,
    privateKeyHandle: hybrids.privateKeyHandle,
    nextSignHandleIndex: 0,
  };
}

export function signBwsGetRequestWithTransferredNitro(
  requestPath: string,
  firstHashHybrid: QuickCryptoHashHybrid,
  signHandleHybrid: QuickCryptoSignHybrid,
  privateKeyHandle: QuickCryptoKeyObjectHybrid,
): string {
  'worklet';

  ensurePortfolioRuntimeSigningGlobals();

  const signingMessage = `get|${requestPath}|{}`;

  firstHashHybrid.createHash('sha256');
  firstHashHybrid.update(signingMessage);
  const sha256Once = NodeBuffer.from(firstHashHybrid.digest());

  signHandleHybrid.init('sha256');
  signHandleHybrid.update(nodeBufferToArrayBuffer(sha256Once));

  const bitcoreLib = getBitcoreLibForRuntime();
  const rawNitroSignatureHex = NodeBuffer.from(
    signHandleHybrid.sign(privateKeyHandle, undefined, undefined, 0),
  ).toString('hex');
  const nitroSignature = bitcoreLib.crypto.Signature.fromString(
    rawNitroSignatureHex,
  );

  return nitroSignature.hasLowS()
    ? rawNitroSignatureHex
    : new bitcoreLib.crypto.Signature({
        r: nitroSignature.r,
        s: bitcoreLib.crypto.Point.getN().sub(nitroSignature.s),
        compressed: nitroSignature.compressed,
        isSchnorr: nitroSignature.isSchnorr,
        nhashtype: nitroSignature.nhashtype,
        i: nitroSignature.i,
      }).toString();
}

export function signBwsGetRequestWithBitcore(
  requestPath: string,
  requestPrivKey: string,
): string {
  'worklet';

  ensurePortfolioRuntimeSigningGlobals();

  const signingMessage = `get|${requestPath}|{}`;
  const bitcoreLib = getBitcoreLibForRuntime();
  const privateKey = new bitcoreLib.PrivateKey(requestPrivKey);
  const hash = bitcoreLib.crypto.Hash.sha256sha256(
    NodeBuffer.from(signingMessage),
  );
  const signature = bitcoreLib.crypto.ECDSA.sign(hash, privateKey);

  if (!signature || typeof signature.toString !== 'function') {
    throw new Error('bitcore-lib did not return a serializable BWS signature.');
  }

  return signature.toString();
}

export function setPortfolioTxHistorySigningDispatchContextOnRuntime(
  context: PortfolioTxHistorySigningDispatchContext | null | undefined,
): void {
  'worklet';

  (globalThis as GlobalWithPortfolioSigningContext)[
    PORTFOLIO_TX_HISTORY_SIGNING_CONTEXT_GLOBAL_KEY
  ] = context || undefined;
}

export function clearPortfolioTxHistorySigningDispatchContextOnRuntime(): void {
  'worklet';

  delete (globalThis as GlobalWithPortfolioSigningContext)[
    PORTFOLIO_TX_HISTORY_SIGNING_CONTEXT_GLOBAL_KEY
  ];
}

export function getPortfolioTxHistorySigningDispatchContextOnRuntime():
  | PortfolioTxHistorySigningDispatchContext
  | undefined {
  'worklet';

  return (globalThis as GlobalWithPortfolioSigningContext)[
    PORTFOLIO_TX_HISTORY_SIGNING_CONTEXT_GLOBAL_KEY
  ] as PortfolioTxHistorySigningDispatchContext | undefined;
}

export function takeNextPortfolioTransferredSignHandleOnRuntime(): {
  firstHashHybrid: QuickCryptoHashHybrid;
  signHandleHybrid: QuickCryptoSignHybrid;
  privateKeyHandle: QuickCryptoKeyObjectHybrid;
} | null {
  'worklet';

  const context = getPortfolioTxHistorySigningDispatchContextOnRuntime();
  if (
    !context?.firstHashHybrid ||
    !context?.privateKeyHandle ||
    !Array.isArray(context.signHandleHybrids) ||
    !context.signHandleHybrids.length
  ) {
    return null;
  }

  const rawNextIndex = Math.max(0, Math.floor(context.nextSignHandleIndex ?? 0));
  const signHandleCount = context.signHandleHybrids.length;
  const nextIndex = signHandleCount > 0 ? rawNextIndex % signHandleCount : 0;
  const signHandleHybrid = context.signHandleHybrids[nextIndex];
  if (!signHandleHybrid) {
    return null;
  }

  context.nextSignHandleIndex = rawNextIndex + 1;

  return {
    firstHashHybrid: context.firstHashHybrid,
    signHandleHybrid,
    privateKeyHandle: context.privateKeyHandle,
  };
}
