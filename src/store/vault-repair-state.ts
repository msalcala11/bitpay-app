import {vaultError, VaultPhase} from './vault-diagnostics';

export const CLEANUP_RECEIPT = 'bip02CleanupReceipt';
export type SourceKind =
  | 'mmkv'
  | 'async'
  | 'main'
  | 'bak'
  | 'main-temp'
  | 'bak-temp';
export type CleanupSlot = 'async' | 'main' | 'bak';
export type CleanupBinding = {
  origin: 'converted-source' | 'optional-refresh' | 'current-coverage';
  digest: string;
};
export type CleanupState = {
  v: 1;
  primaryReceipt?: string;
  suspended?: true;
  async?: CleanupBinding;
  main?: CleanupBinding;
  bak?: CleanupBinding;
};
export type ConversionPlan = {
  v: 1;
  source: SourceKind;
  sourceDigest: string;
  mainDigest: string;
  primaryReceipt: string;
};
export type VaultRecord = {
  status: 'started' | 'complete';
  wipeDone: boolean;
  initializing?: true;
  refresh?: {path: 'main' | 'bak'; digest: string};
  conversionComplete?: true;
  conversionPlan?: ConversionPlan;
  cleanup?: CleanupState;
};
const object = (v: any): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const validReceipt = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
export const conversionEstablished = (r: VaultRecord | undefined): boolean =>
  r?.status === 'complete' || r?.conversionComplete === true;

export const parseCleanup = (v: unknown): CleanupState | undefined => {
  if (
    !object(v) ||
    v.v !== 1 ||
    Object.keys(v).some(
      k =>
        !['v', 'primaryReceipt', 'suspended', 'async', 'main', 'bak'].includes(
          k,
        ),
    ) ||
    (v.primaryReceipt !== undefined && !validReceipt(v.primaryReceipt)) ||
    (v.suspended !== undefined && v.suspended !== true)
  )
    return;
  for (const slot of ['async', 'main', 'bak']) {
    const b = v[slot];
    if (b === undefined) continue;
    if (
      !object(b) ||
      Object.keys(b).some(k => !['origin', 'digest'].includes(k)) ||
      !hash(b.digest) ||
      ![
        'current-coverage',
        slot === 'async' ? 'converted-source' : 'optional-refresh',
      ].includes(b.origin)
    )
      return;
  }
  return v as CleanupState;
};

export const parseVaultRecord = (
  raw: string,
  phase: VaultPhase = 'inventory',
): VaultRecord => {
  const invalid = (): never => {
    throw vaultError('PRESERVATION_FAILURE', phase, 'RECORD_INVALID', 'record');
  };
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (
    !object(v) ||
    !['started', 'complete'].includes(v.status) ||
    typeof v.wipeDone !== 'boolean' ||
    (v.status === 'complete' && !v.wipeDone) ||
    (v.initializing !== undefined && v.initializing !== true) ||
    (v.refresh !== undefined &&
      (!object(v.refresh) ||
        !['main', 'bak'].includes(v.refresh.path) ||
        !hash(v.refresh.digest)))
  )
    return invalid();
  // Retired extension content never becomes a completed-startup dependency.
  if (v.status === 'complete') return v as VaultRecord;
  if (v.conversionComplete !== undefined && v.conversionComplete !== true)
    return invalid();
  if (!v.conversionComplete && v.conversionPlan !== undefined) {
    const p = v.conversionPlan;
    if (
      !object(p) ||
      p.v !== 1 ||
      Object.keys(p).some(
        k =>
          ![
            'v',
            'source',
            'sourceDigest',
            'mainDigest',
            'primaryReceipt',
          ].includes(k),
      ) ||
      !['mmkv', 'async', 'main', 'bak', 'main-temp', 'bak-temp'].includes(
        p.source,
      ) ||
      !hash(p.sourceDigest) ||
      !hash(p.mainDigest) ||
      !validReceipt(p.primaryReceipt)
    )
      return invalid();
  }
  // Fail closed for optional deletion permissions, independently of conversion.
  return {...v, cleanup: parseCleanup(v.cleanup)} as VaultRecord;
};
