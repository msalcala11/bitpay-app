import {Buffer as NodeBuffer} from 'buffer';
import processPolyfill from 'process';
import type {
  NitroRequest as NitroFetchRequest,
  NitroResponse as NitroFetchResponse,
} from 'react-native-nitro-fetch';

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
  exportKey?(
    format?: number,
    type?: number,
    cipher?: string,
    passphrase?: ArrayBuffer,
  ): ArrayBuffer;
  exportJwk?(
    key: Record<string, unknown>,
    handleRsaPss: boolean,
  ): Record<string, unknown>;
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
    SPKI: number;
    SEC1: number;
  };
};

type NitroModulesLike = {
  createHybridObject<T = unknown>(name: string): T;
  box?<T = unknown>(obj: T): BoxedHybridObjectLike<T>;
};

export type TransferredNitroBwsSigningBatchHybrids = {
  firstHash: QuickCryptoHashHybrid;
  signHandles: QuickCryptoSignHybrid[];
  privateKeyHandle: QuickCryptoKeyObjectHybrid;
};

export type PortfolioQuickCryptoPubKeyProbeResult = {
  probeKeyTag: string;
  requestPrivKeySec1DerHex: string;
  publicKeySpkiHex?: string;
  publicKeySpkiExportError?: string;
  publicJwk: {
    kty?: string;
    crv?: string;
    x?: string;
    y?: string;
  };
  publicKeyXHex: string;
  publicKeyYHex: string;
  compressedPublicKeyHex: string;
  uncompressedPublicKeyHex: string;
};

type BoxedHybridObjectLike<T> = {
  unbox(): T;
};

type NitroFetchClientHybrid = {
  request(req: NitroFetchRequest): Promise<NitroFetchResponse>;
  requestSync(req: NitroFetchRequest): NitroFetchResponse;
};

type NitroFetchHybrid = {
  createClient(): NitroFetchClientHybrid;
};

export type PortfolioTxHistorySigningDispatchContext = {
  requestPrivKey?: string;
  requestPubKey?: string;
  requestCount?: number;
  requestPrivKeySec1DerHex?: string;
  boxedNitroModulesProxy?: BoxedHybridObjectLike<NitroModulesLike>;
  boxedNitroFetch?: BoxedHybridObjectLike<NitroFetchHybrid>;
  nitroFetchClient?: NitroFetchClientHybrid;
  firstHashHybrid?: QuickCryptoHashHybrid;
  signHandleHybrids?: QuickCryptoSignHybrid[];
  privateKeyHandle?: QuickCryptoKeyObjectHybrid;
  nextSignHandleIndex?: number;
};

// Rate fetches share the Nitro transport handles but intentionally do not carry
// wallet signing material or transferred Quick Crypto sign handles.
export type PortfolioNitroFetchDispatchContext =
  PortfolioTxHistorySigningDispatchContext;

type GlobalWithPortfolioSigningContext = typeof globalThis & {
  __bitpayPortfolioTxHistorySigningContextV1__?:
    | PortfolioTxHistorySigningDispatchContext
    | null;
  __bitpayPortfolioBitcoreLibV1__?: any;
  NitroModulesProxy?: NitroModulesLike;
};

const PORTFOLIO_TX_HISTORY_SIGNING_CONTEXT_GLOBAL_KEY =
  '__bitpayPortfolioTxHistorySigningContextV1__';
const SECP256K1_CURVE_ORDER_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
const SECP256K1_CURVE_HALF_ORDER_HEX =
  '7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0';
export const DEFAULT_PORTFOLIO_NITRO_FETCH_TIMEOUT_MS = 15000;
export const PORTFOLIO_REQUEST_KEY_DEBUG_PROBE_PRIVATE_KEY_HEX =
  '3da1b53f027ed856bb1922dde7438f91309a59fa1a3aaf7f64dd7f46a258c73c';
const PORTFOLIO_REQUEST_KEY_DEBUG_PROBE_KEY_TAG = 'fixed_test_vector_v1';
const QUICK_CRYPTO_ENUMS: QuickCryptoEnums = {
  KeyType: {
    PRIVATE: 2,
  },
  KFormatType: {
    DER: 0,
  },
  KeyEncoding: {
    SPKI: 2,
    SEC1: 3,
  },
};
let sharedBoxedNitroFetchOnJS: BoxedHybridObjectLike<NitroFetchHybrid> | undefined;
let sharedBoxedNitroModulesProxyOnJS:
  | BoxedHybridObjectLike<NitroModulesLike>
  | undefined;

function nowMs(): number {
  const candidate = globalThis?.performance?.now?.();
  return Number.isFinite(candidate) ? Number(candidate) : Date.now();
}

type PortfolioTxHistorySigningContextBuildStepMetrics = {
  elapsedMs?: number;
  cacheMiss?: boolean;
};

type PortfolioTxHistorySec1DerBuildMetrics = {
  elapsedMs?: number;
  bitcoreLoadElapsedMs?: number;
  bitcoreLoadCacheMiss?: boolean;
  privateKeyParseElapsedMs?: number;
  privateKeyToBufferElapsedMs?: number;
  sec1DerEncodeElapsedMs?: number;
};

export type PortfolioTxHistorySigningContextBuildMetrics = {
  totalElapsedMs?: number;
  requestPrivKeyPresent?: boolean;
  nitroModulesProxy?: PortfolioTxHistorySigningContextBuildStepMetrics;
  nitroFetch?: PortfolioTxHistorySigningContextBuildStepMetrics;
  requestPrivKeySec1Der?: PortfolioTxHistorySec1DerBuildMetrics;
  objectAssemblyElapsedMs?: number;
};

function getBitcoreLibOnJS(
  metrics?: PortfolioTxHistorySigningContextBuildStepMetrics,
): any {
  const startedAt = metrics ? nowMs() : 0;
  const globalRef = globalThis as GlobalWithPortfolioSigningContext;
  const cacheMiss = !globalRef.__bitpayPortfolioBitcoreLibV1__;
  if (cacheMiss) {
    const importedBitcoreLib = require('@bitpay-labs/bitcore-lib') as any;
    globalRef.__bitpayPortfolioBitcoreLibV1__ =
      importedBitcoreLib?.default || importedBitcoreLib;
  }

  const bitcoreLib = globalRef.__bitpayPortfolioBitcoreLibV1__;
  if (!bitcoreLib?.PrivateKey) {
    throw new Error('@bitpay-labs/bitcore-lib is unavailable on the RN host.');
  }

  if (metrics) {
    metrics.elapsedMs = nowMs() - startedAt;
    metrics.cacheMiss = cacheMiss;
  }

  return bitcoreLib;
}

function getNitroModulesOnJS(): NitroModulesLike {
  const importedNitroModules = require('react-native-nitro-modules') as any;
  const nitroModules =
    importedNitroModules?.NitroModules ||
    importedNitroModules?.default?.NitroModules;

  if (typeof nitroModules?.createHybridObject !== 'function') {
    throw new Error(
      'react-native-nitro-modules.NitroModules.createHybridObject() is unavailable on the RN host.',
    );
  }

  return nitroModules as NitroModulesLike;
}

function getNitroModulesForRN(): NitroModulesLike {
  'worklet';

  const nitroModules = (globalThis as GlobalWithPortfolioSigningContext)
    .NitroModulesProxy;
  if (typeof nitroModules?.createHybridObject === 'function') {
    return nitroModules as NitroModulesLike;
  }

  // Jest and other host-only environments exercise these helpers on the JS
  // thread without a dedicated worklet runtime. Fall back to the host module
  // when CommonJS is actually available there.
  if (typeof require === 'function') {
    return getNitroModulesOnJS();
  }

  if (typeof nitroModules?.createHybridObject !== 'function') {
    throw new Error(
      'react-native-nitro-modules.NitroModules.createHybridObject() is unavailable on the RN runtime.',
    );
  }

  return nitroModules as NitroModulesLike;
}

function createQuickCryptoHashHybridOnRN(): QuickCryptoHashHybrid {
  'worklet';

  return getNitroModulesForRN().createHybridObject<QuickCryptoHashHybrid>(
    'Hash',
  );
}

function createQuickCryptoKeyObjectHybridOnRN(): QuickCryptoKeyObjectHybrid {
  'worklet';

  return getNitroModulesForRN().createHybridObject<QuickCryptoKeyObjectHybrid>(
    'KeyObjectHandle',
  );
}

function createQuickCryptoSignHybridOnRN(): QuickCryptoSignHybrid {
  'worklet';

  return getNitroModulesForRN().createHybridObject<QuickCryptoSignHybrid>(
    'SignHandle',
  );
}

function getSharedBoxedNitroFetchOnJS(
  metrics?: PortfolioTxHistorySigningContextBuildStepMetrics,
): BoxedHybridObjectLike<NitroFetchHybrid> {
  const startedAt = metrics ? nowMs() : 0;
  const cacheMiss = !sharedBoxedNitroFetchOnJS;
  if (cacheMiss) {
    const nitroModules = getNitroModulesOnJS();
    if (typeof nitroModules.box !== 'function') {
      throw new Error(
        'react-native-nitro-modules.NitroModules.box() is unavailable on the RN host.',
      );
    }

    const {NitroFetch: nitroFetchSingleton} = require(
      'react-native-nitro-fetch',
    ) as {
      NitroFetch: NitroFetchHybrid;
    };

    sharedBoxedNitroFetchOnJS = nitroModules.box(nitroFetchSingleton);
  }

  if (metrics) {
    metrics.elapsedMs = nowMs() - startedAt;
    metrics.cacheMiss = cacheMiss;
  }

  return sharedBoxedNitroFetchOnJS;
}

function getSharedBoxedNitroModulesProxyOnJS(
  metrics?: PortfolioTxHistorySigningContextBuildStepMetrics,
): BoxedHybridObjectLike<NitroModulesLike> {
  const startedAt = metrics ? nowMs() : 0;
  const cacheMiss = !sharedBoxedNitroModulesProxyOnJS;
  if (cacheMiss) {
    const nitroModules = getNitroModulesOnJS();
    if (typeof nitroModules.box !== 'function') {
      throw new Error(
        'react-native-nitro-modules.NitroModules.box() is unavailable on the RN host.',
      );
    }

    sharedBoxedNitroModulesProxyOnJS = nitroModules.box(nitroModules);
  }

  if (metrics) {
    metrics.elapsedMs = nowMs() - startedAt;
    metrics.cacheMiss = cacheMiss;
  }

  return sharedBoxedNitroModulesProxyOnJS;
}

function installPortfolioNitroModulesProxyOnRuntime(
  boxedNitroModulesProxy:
    | BoxedHybridObjectLike<NitroModulesLike>
    | undefined,
): void {
  'worklet';

  if (!boxedNitroModulesProxy) {
    return;
  }

  const globalRef = globalThis as GlobalWithPortfolioSigningContext;
  if (typeof globalRef.NitroModulesProxy?.createHybridObject === 'function') {
    return;
  }

  globalRef.NitroModulesProxy = boxedNitroModulesProxy.unbox();
}

function getQuickCryptoEnumsForRN(): QuickCryptoEnums {
  'worklet';

  if (
    typeof QUICK_CRYPTO_ENUMS.KeyType?.PRIVATE !== 'number' ||
    typeof QUICK_CRYPTO_ENUMS.KFormatType?.DER !== 'number' ||
    typeof QUICK_CRYPTO_ENUMS.KeyEncoding?.SEC1 !== 'number'
  ) {
    throw new Error(
      'react-native-quick-crypto key import enums are unavailable on the RN runtime.',
    );
  }

  return QUICK_CRYPTO_ENUMS;
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
  if (
    !globalRef.Buffer &&
    typeof (NodeBuffer as {from?: unknown})?.from === 'function'
  ) {
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

function bytesToHex(bytes: ArrayLike<number>): string {
  'worklet';

  let hex = '';

  for (let index = 0; index < bytes.length; index += 1) {
    hex += Number(bytes[index]).toString(16).padStart(2, '0');
  }

  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  'worklet';

  const normalizedHex = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(normalizedHex.length / 2);

  for (let index = 0; index < normalizedHex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalizedHex.slice(index, index + 2), 16);
  }

  return bytes;
}

function base64UrlToBytes(base64Url: string): Uint8Array {
  'worklet';

  const normalized = String(base64Url || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded =
    normalized.length % 4 === 0
      ? normalized
      : normalized.padEnd(normalized.length + (4 - (normalized.length % 4)), '=');
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const paddingLength = padded.endsWith('==') ? 2 : padded.endsWith('=') ? 1 : 0;
  const outputLength = (padded.length / 4) * 3 - paddingLength;
  const output = new Uint8Array(outputLength);
  let outputIndex = 0;

  for (let index = 0; index < padded.length; index += 4) {
    const chars = padded.slice(index, index + 4);
    let value = 0;

    for (let offset = 0; offset < 4; offset += 1) {
      const char = chars[offset];
      if (char === '=') {
        value *= 64;
        continue;
      }

      const alphabetIndex = alphabet.indexOf(char);
      if (alphabetIndex < 0) {
        throw new Error(
          `Encountered an invalid base64url character while decoding Quick Crypto JWK output: ${char}.`,
        );
      }

      value = value * 64 + alphabetIndex;
    }

    if (outputIndex < outputLength) {
      output[outputIndex] = Math.floor(value / 65536) % 256;
      outputIndex += 1;
    }
    if (outputIndex < outputLength) {
      output[outputIndex] = Math.floor(value / 256) % 256;
      outputIndex += 1;
    }
    if (outputIndex < outputLength) {
      output[outputIndex] = value % 256;
      outputIndex += 1;
    }
  }

  return output;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  'worklet';

  let totalLength = 0;
  for (const part of parts) {
    totalLength += part.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

function uint8ArrayToArrayBuffer(view: Uint8Array): ArrayBuffer {
  'worklet';

  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function buildSecp256k1Sec1PrivateKeyDer(
  privateKeyBytes: ArrayLike<number>,
): Uint8Array {
  'worklet';

  if (privateKeyBytes.length !== 32) {
    throw new Error(
      `Expected a 32-byte secp256k1 private key, received ${privateKeyBytes.length} bytes.`,
    );
  }

  return concatBytes(
    Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x01, 0x04, 0x20]),
    Uint8Array.from(privateKeyBytes),
    Uint8Array.from([0xa0, 0x07, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a]),
  );
}

function normalizeSecp256k1PrivateKeyHexForProbe(rawPrivateKeyHex: string): string {
  'worklet';

  const normalized = String(rawPrivateKeyHex || '')
    .trim()
    .replace(/^0x/i, '')
    .toLowerCase();

  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(
      'Quick Crypto pubkey probe requires a 32-byte secp256k1 private key hex string.',
    );
  }

  return normalized;
}

function buildSecp256k1PublicKeyHexFromEcJwk(jwk: {
  x?: unknown;
  y?: unknown;
}): {
  publicKeyXHex: string;
  publicKeyYHex: string;
  compressedPublicKeyHex: string;
  uncompressedPublicKeyHex: string;
} {
  'worklet';

  const xBase64Url = String(jwk?.x || '').trim();
  const yBase64Url = String(jwk?.y || '').trim();
  if (!xBase64Url || !yBase64Url) {
    throw new Error(
      'QuickCrypto KeyObjectHandle.exportJwk() did not return EC x/y coordinates.',
    );
  }

  const xBytes = base64UrlToBytes(xBase64Url);
  const yBytes = base64UrlToBytes(yBase64Url);
  if (xBytes.length !== 32 || yBytes.length !== 32) {
    throw new Error(
      `Expected 32-byte secp256k1 public key coordinates, received x=${xBytes.length}, y=${yBytes.length}.`,
    );
  }

  const publicKeyXHex = bytesToHex(xBytes);
  const publicKeyYHex = bytesToHex(yBytes);
  const compressedPrefix = yBytes[yBytes.length - 1] % 2 === 0 ? '02' : '03';

  return {
    publicKeyXHex,
    publicKeyYHex,
    compressedPublicKeyHex: `${compressedPrefix}${publicKeyXHex}`,
    uncompressedPublicKeyHex: `04${publicKeyXHex}${publicKeyYHex}`,
  };
}

function buildRequestPrivKeySec1DerHexOnJS(
  requestPrivKey: string,
  metrics?: PortfolioTxHistorySec1DerBuildMetrics,
): string {
  const startedAt = metrics ? nowMs() : 0;
  const bitcoreLoadMetrics = metrics
    ? ({} as PortfolioTxHistorySigningContextBuildStepMetrics)
    : undefined;
  const bitcore = getBitcoreLibOnJS(bitcoreLoadMetrics);
  const privateKeyParseStartedAt = metrics ? nowMs() : 0;
  const privateKey = new bitcore.PrivateKey(requestPrivKey);
  const privateKeyParseElapsedMs = metrics
    ? nowMs() - privateKeyParseStartedAt
    : 0;
  const privateKeyToBufferStartedAt = metrics ? nowMs() : 0;
  const privateKeyBytes = Uint8Array.from(privateKey.toBuffer());
  const privateKeyToBufferElapsedMs = metrics
    ? nowMs() - privateKeyToBufferStartedAt
    : 0;
  const sec1DerEncodeStartedAt = metrics ? nowMs() : 0;
  const sec1DerHex = bytesToHex(buildSecp256k1Sec1PrivateKeyDer(privateKeyBytes));

  if (metrics) {
    metrics.elapsedMs = nowMs() - startedAt;
    metrics.bitcoreLoadElapsedMs = bitcoreLoadMetrics?.elapsedMs;
    metrics.bitcoreLoadCacheMiss = bitcoreLoadMetrics?.cacheMiss;
    metrics.privateKeyParseElapsedMs = privateKeyParseElapsedMs;
    metrics.privateKeyToBufferElapsedMs = privateKeyToBufferElapsedMs;
    metrics.sec1DerEncodeElapsedMs = nowMs() - sec1DerEncodeStartedAt;
  }

  return sec1DerHex;
}

export function createTransferredNitroBwsSigningBatchOnRN(
  requestPrivKeySec1DerHex: string,
  requestCount: number,
): TransferredNitroBwsSigningBatchHybrids {
  'worklet';

  const {KeyType, KFormatType, KeyEncoding} = getQuickCryptoEnumsForRN();
  const sec1DerHex = String(requestPrivKeySec1DerHex || '').trim();
  if (!sec1DerHex) {
    throw new Error(
      'A SEC1 DER-encoded request private key is required to hydrate Nitro signing handles.',
    );
  }

  const firstHash = createQuickCryptoHashHybridOnRN();
  const privateKeyHandle = createQuickCryptoKeyObjectHybridOnRN();
  const signHandles: QuickCryptoSignHybrid[] = [];

  const initialized = privateKeyHandle.init(
    KeyType.PRIVATE,
    uint8ArrayToArrayBuffer(hexToBytes(sec1DerHex)),
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

export function probeQuickCryptoRequestPubKeyDerivationOnRN(args?: {
  rawPrivateKeyHex?: string;
}): PortfolioQuickCryptoPubKeyProbeResult {
  'worklet';

  ensurePortfolioRuntimeSigningGlobals();

  const rawPrivateKeyHex = normalizeSecp256k1PrivateKeyHexForProbe(
    String(
      args?.rawPrivateKeyHex || PORTFOLIO_REQUEST_KEY_DEBUG_PROBE_PRIVATE_KEY_HEX,
    ),
  );
  const requestPrivKeySec1DerHex = bytesToHex(
    buildSecp256k1Sec1PrivateKeyDer(hexToBytes(rawPrivateKeyHex)),
  );
  const {KeyType, KFormatType, KeyEncoding} = getQuickCryptoEnumsForRN();
  if (typeof KeyEncoding.SPKI !== 'number') {
    throw new Error(
      'react-native-quick-crypto SPKI export enums are unavailable on the RN runtime.',
    );
  }

  const privateKeyHandle = createQuickCryptoKeyObjectHybridOnRN();
  const initialized = privateKeyHandle.init(
    KeyType.PRIVATE,
    uint8ArrayToArrayBuffer(hexToBytes(requestPrivKeySec1DerHex)),
    KFormatType.DER,
    KeyEncoding.SEC1,
  );

  if (!initialized) {
    throw new Error(
      'QuickCrypto KeyObjectHandle.init() returned false during the pubkey derivation probe.',
    );
  }

  let publicKeySpkiHex: string | undefined;
  let publicKeySpkiExportError: string | undefined;
  if (typeof privateKeyHandle.exportKey === 'function') {
    try {
      publicKeySpkiHex = bytesToHex(
        new Uint8Array(
          privateKeyHandle.exportKey(KFormatType.DER, KeyEncoding.SPKI),
        ),
      );
    } catch (error: unknown) {
      publicKeySpkiExportError =
        error instanceof Error ? error.message : String(error);
    }
  }

  if (typeof privateKeyHandle.exportJwk !== 'function') {
    throw new Error(
      'QuickCrypto KeyObjectHandle.exportJwk() is unavailable on the RN runtime.',
    );
  }

  const exportedJwk = privateKeyHandle.exportJwk({}, false);
  const publicJwk = {
    kty:
      typeof exportedJwk?.kty === 'string' ? String(exportedJwk.kty) : undefined,
    crv:
      typeof exportedJwk?.crv === 'string' ? String(exportedJwk.crv) : undefined,
    x: typeof exportedJwk?.x === 'string' ? String(exportedJwk.x) : undefined,
    y: typeof exportedJwk?.y === 'string' ? String(exportedJwk.y) : undefined,
  };
  const publicKeyHex = buildSecp256k1PublicKeyHexFromEcJwk(publicJwk);

  return {
    probeKeyTag: PORTFOLIO_REQUEST_KEY_DEBUG_PROBE_KEY_TAG,
    requestPrivKeySec1DerHex,
    publicKeySpkiHex,
    publicKeySpkiExportError,
    publicJwk,
    ...publicKeyHex,
  };
}

export function createPortfolioTxHistorySigningDispatchContextOnRN(args: {
  requestPrivKey?: string;
  requestPubKey?: string;
  requestCount?: number;
},
metrics?: PortfolioTxHistorySigningContextBuildMetrics,
): PortfolioTxHistorySigningDispatchContext {
  const startedAt = metrics ? nowMs() : 0;
  const nitroModulesProxyMetrics = metrics
    ? ({} as PortfolioTxHistorySigningContextBuildStepMetrics)
    : undefined;
  const nitroFetchMetrics = metrics
    ? ({} as PortfolioTxHistorySigningContextBuildStepMetrics)
    : undefined;
  const boxedNitroModulesProxy = getSharedBoxedNitroModulesProxyOnJS(
    nitroModulesProxyMetrics,
  );
  const boxedNitroFetch = getSharedBoxedNitroFetchOnJS(nitroFetchMetrics);
  const requestPrivKey = String(args.requestPrivKey || '').trim();
  const requestPubKey = String(args.requestPubKey || '').trim() || undefined;
  const requestCount = Math.max(1, Math.floor(args.requestCount ?? 4));
  const objectAssemblyStartedAt = metrics ? nowMs() : 0;

  if (metrics) {
    metrics.requestPrivKeyPresent = !!requestPrivKey;
    metrics.nitroModulesProxy = nitroModulesProxyMetrics;
    metrics.nitroFetch = nitroFetchMetrics;
  }

  if (!requestPrivKey) {
    const context = {
      requestPubKey,
      requestCount,
      boxedNitroModulesProxy,
      boxedNitroFetch,
      nextSignHandleIndex: 0,
    };

    if (metrics) {
      metrics.objectAssemblyElapsedMs = nowMs() - objectAssemblyStartedAt;
      metrics.totalElapsedMs = nowMs() - startedAt;
    }

    return context;
  }

  const requestPrivKeySec1DerMetrics = metrics
    ? ({} as PortfolioTxHistorySec1DerBuildMetrics)
    : undefined;
  const requestPrivKeySec1DerHex = buildRequestPrivKeySec1DerHexOnJS(
    requestPrivKey,
    requestPrivKeySec1DerMetrics,
  );
  const context = {
    requestPrivKey,
    requestPubKey,
    requestCount,
    requestPrivKeySec1DerHex,
    boxedNitroModulesProxy,
    boxedNitroFetch,
    nextSignHandleIndex: 0,
  };

  if (metrics) {
    metrics.requestPrivKeySec1Der = requestPrivKeySec1DerMetrics;
    metrics.objectAssemblyElapsedMs = nowMs() - objectAssemblyStartedAt;
    metrics.totalElapsedMs = nowMs() - startedAt;
  }

  return context;
}

export function createPortfolioRateFetchDispatchContextOnRN(args?: {
  requestCount?: number;
}): PortfolioNitroFetchDispatchContext {
  const boxedNitroModulesProxy = getSharedBoxedNitroModulesProxyOnJS();
  const boxedNitroFetch = getSharedBoxedNitroFetchOnJS();
  const requestCount = Math.max(1, Math.floor(args?.requestCount ?? 1));

  return {
    requestCount,
    boxedNitroModulesProxy,
    boxedNitroFetch,
    nextSignHandleIndex: 0,
  };
}

function ensurePortfolioTxHistorySigningDispatchContextHydratedOnRuntime(
  context: PortfolioTxHistorySigningDispatchContext | undefined,
): PortfolioTxHistorySigningDispatchContext | undefined {
  'worklet';

  if (!context) {
    return context;
  }

  const requestPrivKey = String(context.requestPrivKey || '').trim();
  if (!requestPrivKey) {
    return context;
  }

  const needsTransferredNitroBatch =
    !context.firstHashHybrid ||
    !context.privateKeyHandle ||
    !Array.isArray(context.signHandleHybrids) ||
    !context.signHandleHybrids.length;

  if (needsTransferredNitroBatch) {
    const requestPrivKeySec1DerHex = String(
      context.requestPrivKeySec1DerHex || '',
    ).trim();
    if (!requestPrivKeySec1DerHex) {
      throw new Error(
        'No SEC1 DER-encoded request private key is available on the portfolio runtime for Nitro signing hydration.',
      );
    }

    const hybrids = createTransferredNitroBwsSigningBatchOnRN(
      requestPrivKeySec1DerHex,
      context.requestCount ?? 4,
    );

    context.firstHashHybrid = hybrids.firstHash;
    context.signHandleHybrids = hybrids.signHandles;
    context.privateKeyHandle = hybrids.privateKeyHandle;
  }

  context.nextSignHandleIndex = Math.max(
    0,
    Math.floor(context.nextSignHandleIndex ?? 0),
  );

  return context;
}

function parseDerSignature(signatureHex: string): {r: bigint; s: bigint} {
  'worklet';

  const signatureBytes = hexToBytes(signatureHex);
  if (signatureBytes.length < 8) {
    throw new Error(
      `Expected a DER-encoded ECDSA signature, received ${signatureBytes.length} bytes.`,
    );
  }

  if (signatureBytes[0] !== 0x30) {
    throw new Error(
      `Expected DER sequence prefix 0x30, received 0x${signatureBytes[0].toString(
        16,
      )}.`,
    );
  }

  const sequenceLength = signatureBytes[1];
  if (sequenceLength !== signatureBytes.length - 2) {
    throw new Error(
      `Unexpected DER sequence length ${sequenceLength}; actual payload length is ${
        signatureBytes.length - 2
      }.`,
    );
  }

  if (signatureBytes[2] !== 0x02) {
    throw new Error(
      `Expected DER integer marker for r, received 0x${signatureBytes[2].toString(
        16,
      )}.`,
    );
  }

  const rLength = signatureBytes[3];
  const rStart = 4;
  const rEnd = rStart + rLength;

  if (signatureBytes[rEnd] !== 0x02) {
    throw new Error(
      `Expected DER integer marker for s, received 0x${signatureBytes[rEnd].toString(
        16,
      )}.`,
    );
  }

  const sLength = signatureBytes[rEnd + 1];
  const sStart = rEnd + 2;
  const sEnd = sStart + sLength;

  if (sEnd !== signatureBytes.length) {
    throw new Error(
      `Unexpected DER signature tail length ${signatureBytes.length - sEnd}.`,
    );
  }

  const rBytes = signatureBytes.subarray(rStart, rEnd);
  const sBytes = signatureBytes.subarray(sStart, sEnd);

  if (!rBytes.length || !sBytes.length) {
    throw new Error('DER signature is missing an r or s component.');
  }

  return {
    r: BigInt(`0x${bytesToHex(rBytes)}`),
    s: BigInt(`0x${bytesToHex(sBytes)}`),
  };
}

function encodeDerInteger(value: bigint): Uint8Array {
  'worklet';

  if (value < 0n) {
    throw new Error('DER integer encoding only supports non-negative values.');
  }

  let hex = value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }

  let bytes = hex.length > 0 ? hexToBytes(hex) : Uint8Array.of(0x00);

  while (bytes.length > 1 && bytes[0] === 0x00 && bytes[1] < 0x80) {
    bytes = bytes.subarray(1);
  }

  if (bytes[0] >= 0x80) {
    bytes = concatBytes(Uint8Array.of(0x00), bytes);
  }

  return bytes;
}

function encodeDerSignature(r: bigint, s: bigint): string {
  'worklet';

  const rBytes = encodeDerInteger(r);
  const sBytes = encodeDerInteger(s);
  const totalLength = 2 + rBytes.length + 2 + sBytes.length;

  if (totalLength >= 0x80) {
    throw new Error(
      `DER signature payload is too large to encode (${totalLength} bytes).`,
    );
  }

  return bytesToHex(
    concatBytes(
      Uint8Array.of(0x30, totalLength, 0x02, rBytes.length),
      rBytes,
      Uint8Array.of(0x02, sBytes.length),
      sBytes,
    ),
  );
}

function normalizeSecp256k1LowSSignatureHex(signatureHex: string): string {
  'worklet';

  const {r, s} = parseDerSignature(signatureHex);
  const curveHalfOrder = BigInt(`0x${SECP256K1_CURVE_HALF_ORDER_HEX}`);

  if (s <= curveHalfOrder) {
    return signatureHex;
  }

  const curveOrder = BigInt(`0x${SECP256K1_CURVE_ORDER_HEX}`);
  return encodeDerSignature(r, curveOrder - s);
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
  const sha256Once = firstHashHybrid.digest();

  signHandleHybrid.init('sha256');
  signHandleHybrid.update(sha256Once);

  const rawNitroSignatureHex = bytesToHex(
    new Uint8Array(
      signHandleHybrid.sign(privateKeyHandle, undefined, undefined, 0),
    ),
  );

  return normalizeSecp256k1LowSSignatureHex(rawNitroSignatureHex);
}

export function signBwsGetRequestWithBitcore(
  requestPath: string,
  requestPrivKey: string,
): string {
  const signingMessage = `get|${requestPath}|{}`;
  const bitcore = getBitcoreLibOnJS();
  const privateKey = new bitcore.PrivateKey(requestPrivKey);
  const hash = bitcore.crypto.Hash.sha256sha256(
    NodeBuffer.from(signingMessage),
  );
  const signature = bitcore.crypto.ECDSA.sign(hash, privateKey);

  if (!signature || typeof signature.toString !== 'function') {
    throw new Error('bitcore-lib did not return a serializable BWS signature.');
  }

  return signature.toString();
}

export function setPortfolioTxHistorySigningDispatchContextOnRuntime(
  context: PortfolioTxHistorySigningDispatchContext | null | undefined,
): void {
  'worklet';

  installPortfolioNitroModulesProxyOnRuntime(context?.boxedNitroModulesProxy);
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

export function requirePortfolioTxHistorySigningDispatchContextOnRuntime():
  PortfolioTxHistorySigningDispatchContext {
  'worklet';

  const context = ensurePortfolioTxHistorySigningDispatchContextHydratedOnRuntime(
    getPortfolioTxHistorySigningDispatchContextOnRuntime(),
  );
  if (!context) {
    throw new Error(
      'No portfolio runtime request context is initialized on the worklet runtime.',
    );
  }

  return context;
}

export function getPortfolioNitroFetchClientOnRuntime(): NitroFetchClientHybrid {
  'worklet';

  const context = requirePortfolioTxHistorySigningDispatchContextOnRuntime();
  if (context.nitroFetchClient) {
    return context.nitroFetchClient;
  }

  if (!context.boxedNitroFetch) {
    throw new Error(
      'No transferred Nitro Fetch handle is initialized on the portfolio runtime.',
    );
  }

  const nitroFetch = context.boxedNitroFetch.unbox();
  const client = nitroFetch.createClient();
  context.nitroFetchClient = client;
  return client;
}

export function takeNextPortfolioTransferredSignHandleOnRuntime(): {
  firstHashHybrid: QuickCryptoHashHybrid;
  signHandleHybrid: QuickCryptoSignHybrid;
  privateKeyHandle: QuickCryptoKeyObjectHybrid;
} | null {
  'worklet';

  const context = requirePortfolioTxHistorySigningDispatchContextOnRuntime();
  if (
    !context.firstHashHybrid ||
    !context.privateKeyHandle ||
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
