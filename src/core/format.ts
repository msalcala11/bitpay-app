import type {WalletCredentials} from './types';

const EVM_DECIMALS = 18;

export function getAtomicDecimals(credentials: WalletCredentials): number {
  const token = credentials?.token;
  if (token && typeof token.decimals === 'number') return token.decimals;

  const chain = String(
    credentials?.chain || credentials?.coin || '',
  ).toLowerCase();
  switch (chain) {
    case 'btc':
    case 'bch':
    case 'ltc':
    case 'doge':
      return 8;
    case 'eth':
    case 'matic':
    case 'arb':
    case 'base':
    case 'op':
      return EVM_DECIMALS;
    case 'xrp':
      return 6;
    case 'sol':
      return 9;
    default:
      // Fallback to satoshi-like.
      return 8;
  }
}

function toSignificantStr(n: number, maxDecimals: number): string {
  if (!Number.isFinite(n)) return '0';
  // Avoid scientific notation for common crypto ranges.
  const s = n.toFixed(Math.min(maxDecimals, 18));
  // Trim trailing zeros.
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

export function formatAtomicAmount(
  atomic: number | string | bigint,
  credentials: WalletCredentials,
  opts?: {maxDecimals?: number},
): string {
  const decimals = getAtomicDecimals(credentials);
  const maxDecimals = opts?.maxDecimals ?? decimals;

  // Prefer bigint-safe formatting (esp. for EVM 1e18 units), but keep a small
  // number fallback for environments where BigInt parsing could fail.
  try {
    const b = parseAtomicToBigint(atomic);
    return formatBigIntDecimal(b, decimals, maxDecimals);
  } catch {
    const asNum = typeof atomic === 'number' ? atomic : Number(String(atomic));
    const unit = Math.pow(10, decimals);
    return toSignificantStr(asNum / unit, maxDecimals);
  }
}

export function parseAtomicToBigint(v: number | string | bigint): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 0n;

    // IMPORTANT:
    // Atomic-unit values (e.g. wei) frequently exceed Number.MAX_SAFE_INTEGER.
    // If we convert such numbers directly via BigInt(n) / BigInt(Math.trunc(n)),
    // we end up converting the underlying IEEE-754 value (which may differ by a
    // few units from the decimal value that was present in the JSON payload).
    //
    // Example (real-world): 109890109890109900 gets stored as an IEEE-754 value
    // that's actually 109890109890109904. BigInt(109890109890109900) becomes
    // 109890109890109904n and balance snapshots drift by a few wei.
    //
    // To keep our snapshot math consistent with how JSON/string values are
    // produced (JSON.stringify / String(n)), we convert via a decimal string
    // representation first.
    //
    // NOTE: If the number was already parsed by JSON.parse, any precision that
    // was lost there is unrecoverable. This just prevents *additional* drift
    // caused by BigInt(number) rounding differences.

    // Fast path for safe integers.
    if (Number.isSafeInteger(v)) return BigInt(v);

    // Prefer the JS "shortest round-trippable" decimal representation.
    // (This matches JSON.stringify/Number#toString behavior.)
    const s = String(v);

    // Handle scientific notation (Number#toString switches to it for >= 1e21).
    if (/[eE]/.test(s)) {
      const formatted = new Intl.NumberFormat('en-US', {
        useGrouping: false,
        maximumFractionDigits: 0,
      }).format(v);
      const cleaned = formatted.replace(/(?!^-)[^\d]/g, '');
      return cleaned ? BigInt(cleaned) : 0n;
    }

    // Drop any fractional part defensively.
    const m = s.match(/^(-?\d+)(?:\.\d+)?$/);
    if (m) return BigInt(m[1]);

    // Fallback: last-resort truncation.
    return BigInt(Math.trunc(v));
  }
  const s = String(v).trim();
  if (!s) return 0n;
  // Handle scientific notation in strings (e.g. from user input).
  if (/[eE]/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return 0n;
    return parseAtomicToBigint(n);
  }
  // Handle decimal strings defensively: drop fractional part if present.
  const m = s.match(/^(-?\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error('Invalid atomic string');
  return BigInt(m[1]);
}

function pow10BigInt(decimals: number): bigint {
  let out = 1n;
  for (let i = 0; i < decimals; i++) out *= 10n;
  return out;
}

export function formatBigIntDecimal(
  atomic: bigint,
  decimals: number,
  maxDecimals = decimals,
): string {
  const sign = atomic < 0n ? '-' : '';
  let abs = atomic < 0n ? -atomic : atomic;

  if (decimals <= 0) return sign + abs.toString();

  const base = pow10BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0');

  // Trim or shorten fractional digits.
  const sliceTo = Math.max(0, Math.min(decimals, maxDecimals));
  frac = frac.slice(0, sliceTo);
  frac = frac.replace(/0+$/, '');

  return frac ? `${sign}${whole.toString()}.${frac}` : sign + whole.toString();
}

export function formatChainAndNetwork(credentials: WalletCredentials): string {
  const chain = String(
    credentials?.chain || credentials?.coin || '',
  ).toUpperCase();
  const network = String(credentials?.network || '').toLowerCase();
  const niceNetwork = network === 'livenet' ? 'mainnet' : network || 'unknown';
  return `${chain}/${niceNetwork}`;
}

export function formatWalletId(walletId: string, max = 10): string {
  if (walletId.length <= max) return walletId;
  return `${walletId.slice(0, 6)}…${walletId.slice(-4)}`;
}

export function formatUnixTimeSecondsToLocal(tsSeconds?: number): string {
  if (!tsSeconds || !Number.isFinite(tsSeconds)) return '';
  const d = new Date(tsSeconds * 1000);
  return d.toLocaleString();
}

export function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0]?.toUpperCase() + w.slice(1))
    .join(' ');
}
