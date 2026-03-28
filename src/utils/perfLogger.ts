export const TEMP_PERF_LOGGING_ENABLED = true;

const MAX_PERF_LOG_ENTRIES = 2500;

type PerfLogKind = 'event' | 'span_start' | 'span_end';
type PerfSpanStatus = 'ok' | 'error' | 'cancel';

export type PerfMetadata = Record<string, unknown>;

export type PerfLogEntry = {
  id: number;
  kind: PerfLogKind;
  name: string;
  wallTimeIso: string;
  relativeTimeMs: number;
  durationMs?: number;
  status?: PerfSpanStatus;
  metadata?: PerfMetadata;
};

export type PerfLogData = {
  entries: PerfLogEntry[];
  count: number;
  startedAtIso: string;
};

type PerfSpan = {
  cancel: (metadata?: PerfMetadata) => void;
  fail: (error: unknown, metadata?: PerfMetadata) => void;
  finish: (metadata?: PerfMetadata) => void;
};

type SensitiveAliasKind =
  | 'address'
  | 'key'
  | 'revision'
  | 'scope'
  | 'snapshot_sig'
  | 'transaction'
  | 'wallet';

const ADDRESS_KEY_NAMES = new Set([
  'accountaddress',
  'address',
  'addresses',
  'receiveaddress',
  'selectedaccountaddress',
  'tokenaddress',
]);

const WALLET_ID_KEY_NAMES = new Set([
  'walletid',
  'walletids',
]);

const KEY_ID_KEY_NAMES = new Set([
  'chartlifecyclekey',
  'keyid',
  'keyids',
  'visiblekeyidssig',
]);

const TRANSACTION_ID_KEY_NAMES = new Set([
  'transactionid',
  'transactionids',
  'txid',
  'txids',
]);

const SCOPE_KEY_NAMES = new Set(['scopeid']);

const REVISION_KEY_NAMES = new Set([
  'analysisinputsbaserevision',
  'analysisinputsbasekey',
  'attemptrevision',
  'cacherevision',
  'lastattemptrevision',
  'prepcacherevision',
  'preparedinputstargetrevision',
  'timeframerevision',
]);

const SNAPSHOT_SIG_KEY_NAMES = new Set(['snapshotversionsig']);

const ADDRESS_LIKE_PATTERNS = [
  /\b0x[a-fA-F0-9]{40}\b/g,
  /\b(?:bc1|tb1|ltc1|bcrt1)[ac-hj-np-z02-9]{11,87}\b/gi,
  /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g,
  /\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/g,
  /\b[1-9A-HJ-NP-Za-km-z]{32,64}\b/g,
];

const getClockNowMs = () => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }

  return Date.now();
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch (_) {
    return String(error);
  }
};

const normalizeMetadataKey = (key: string) => {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
};

const replaceAll = (value: string, searchValue: string, replaceValue: string) => {
  if (!searchValue) {
    return value;
  }

  return value.split(searchValue).join(replaceValue);
};

const sanitizeMetadata = (metadata?: PerfMetadata): PerfMetadata | undefined => {
  if (!metadata) {
    return undefined;
  }

  const sanitizedEntries = Object.entries(metadata).filter(
    ([, value]) => value !== undefined,
  );

  if (!sanitizedEntries.length) {
    return undefined;
  }

  return Object.fromEntries(sanitizedEntries);
};

const mergeMetadata = (
  baseMetadata?: PerfMetadata,
  extraMetadata?: PerfMetadata,
): PerfMetadata | undefined => {
  return sanitizeMetadata({
    ...(baseMetadata || {}),
    ...(extraMetadata || {}),
  });
};

const serializeMetadataValue = (value: unknown): string => {
  if (value == null) {
    return String(value);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toFixed(1) : String(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'string') {
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 220) {
      return `${serialized.slice(0, 217)}...`;
    }
    return serialized;
  } catch (_) {
    return String(value);
  }
};

const formatMetadata = (metadata?: PerfMetadata) => {
  if (!metadata) {
    return '';
  }

  const entries = Object.entries(metadata);
  if (!entries.length) {
    return '';
  }

  return entries
    .map(([key, value]) => `${key}=${serializeMetadataValue(value)}`)
    .join(' ');
};

class PerfLogger {
  private static instance: PerfLogger;
  private entries: PerfLogEntry[] = [];
  private listeners: Set<(data: PerfLogData) => void> = new Set();
  private isListenerNotificationQueued = false;
  private nextId = 1;
  private startedAtIso = new Date().toISOString();
  private startedClockMs = getClockNowMs();
  private sensitiveAliasMaps: Record<SensitiveAliasKind, Map<string, string>> = {
    address: new Map(),
    key: new Map(),
    revision: new Map(),
    scope: new Map(),
    snapshot_sig: new Map(),
    transaction: new Map(),
    wallet: new Map(),
  };
  private sensitiveAliasCounts: Record<SensitiveAliasKind, number> = {
    address: 0,
    key: 0,
    revision: 0,
    scope: 0,
    snapshot_sig: 0,
    transaction: 0,
    wallet: 0,
  };

  static getInstance(): PerfLogger {
    if (!PerfLogger.instance) {
      PerfLogger.instance = new PerfLogger();
    }

    return PerfLogger.instance;
  }

  getClockNowMs() {
    return getClockNowMs();
  }

  subscribe(listener: (data: PerfLogData) => void): () => void {
    this.listeners.add(listener);
    listener(this.getLogData());
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear() {
    this.entries = [];
    this.nextId = 1;
    this.startedAtIso = new Date().toISOString();
    this.startedClockMs = getClockNowMs();
    this.sensitiveAliasMaps = {
      address: new Map(),
      key: new Map(),
      revision: new Map(),
      scope: new Map(),
      snapshot_sig: new Map(),
      transaction: new Map(),
      wallet: new Map(),
    };
    this.sensitiveAliasCounts = {
      address: 0,
      key: 0,
      revision: 0,
      scope: 0,
      snapshot_sig: 0,
      transaction: 0,
      wallet: 0,
    };
    this.notifyListeners();
  }

  getLogData(): PerfLogData {
    return {
      entries: this.entries,
      count: this.entries.length,
      startedAtIso: this.startedAtIso,
    };
  }

  recordEvent(name: string, metadata?: PerfMetadata) {
    if (!TEMP_PERF_LOGGING_ENABLED) {
      return;
    }

    this.pushEntry({
      kind: 'event',
      name,
      wallTimeIso: new Date().toISOString(),
      relativeTimeMs: getClockNowMs() - this.startedClockMs,
      metadata: this.sanitizePerfMetadata(metadata),
    });
  }

  startSpan(name: string, metadata?: PerfMetadata): PerfSpan {
    if (!TEMP_PERF_LOGGING_ENABLED) {
      return {
        cancel: () => {},
        fail: () => {},
        finish: () => {},
      };
    }

    const startClockMs = getClockNowMs();
    const baseMetadata = sanitizeMetadata(metadata);
    let isClosed = false;

    this.pushEntry({
      kind: 'span_start',
      name,
      wallTimeIso: new Date().toISOString(),
      relativeTimeMs: startClockMs - this.startedClockMs,
      metadata: this.sanitizePerfMetadata(baseMetadata),
    });

    const close = (status: PerfSpanStatus, extraMetadata?: PerfMetadata) => {
      if (isClosed) {
        return;
      }

      isClosed = true;
      const endClockMs = getClockNowMs();

      this.pushEntry({
        kind: 'span_end',
        name,
        wallTimeIso: new Date().toISOString(),
        relativeTimeMs: endClockMs - this.startedClockMs,
        durationMs: endClockMs - startClockMs,
        status,
        metadata: this.sanitizePerfMetadata(
          mergeMetadata(baseMetadata, extraMetadata),
        ),
      });
    };

    return {
      cancel: extraMetadata => close('cancel', extraMetadata),
      fail: (error, extraMetadata) =>
        close('error', {
          ...(extraMetadata || {}),
          error: getErrorMessage(error),
        }),
      finish: extraMetadata => close('ok', extraMetadata),
    };
  }

  formatForExport(exportMetadata?: PerfMetadata): string {
    const {entries, count, startedAtIso} = this.getLogData();
    const exportedAtIso = new Date().toISOString();
    const lines = [
      '# BitPay Perf Logs',
      `startedAt=${startedAtIso}`,
      `exportedAt=${exportedAtIso}`,
      `entryCount=${count}`,
    ];

    const exportMetadataLine = formatMetadata(
      this.sanitizePerfMetadata(exportMetadata),
    );
    if (exportMetadataLine) {
      lines.push(exportMetadataLine);
    }

    lines.push('', '# Timeline');

    if (!entries.length) {
      lines.push('(no perf logs recorded)');
    } else {
      entries.forEach(entry => {
        const parts = [
          String(entry.id).padStart(4, '0'),
          entry.kind,
          entry.name,
          entry.wallTimeIso,
          `t+${entry.relativeTimeMs.toFixed(1)}ms`,
        ];

        if (typeof entry.durationMs === 'number') {
          parts.push(`durationMs=${entry.durationMs.toFixed(1)}`);
        }

        if (entry.status) {
          parts.push(`status=${entry.status}`);
        }

        const metadata = formatMetadata(this.sanitizePerfMetadata(entry.metadata));
        if (metadata) {
          parts.push(metadata);
        }

        lines.push(parts.join(' '));
      });
    }

    lines.push('', '# Span Summary');

    const summaryByName = new Map<
      string,
      {
        cancelCount: number;
        count: number;
        errorCount: number;
        maxMs: number;
        totalMs: number;
      }
    >();

    entries
      .filter(
        (entry): entry is PerfLogEntry & {durationMs: number} =>
          entry.kind === 'span_end' && typeof entry.durationMs === 'number',
      )
      .forEach(entry => {
        const current = summaryByName.get(entry.name) || {
          cancelCount: 0,
          count: 0,
          errorCount: 0,
          maxMs: 0,
          totalMs: 0,
        };

        current.count += 1;
        current.totalMs += entry.durationMs;
        current.maxMs = Math.max(current.maxMs, entry.durationMs);

        if (entry.status === 'cancel') {
          current.cancelCount += 1;
        }

        if (entry.status === 'error') {
          current.errorCount += 1;
        }

        summaryByName.set(entry.name, current);
      });

    if (!summaryByName.size) {
      lines.push('(no completed spans recorded)');
    } else {
      Array.from(summaryByName.entries())
        .sort(([, a], [, b]) => b.totalMs - a.totalMs)
        .forEach(([name, summary]) => {
          const avgMs = summary.count ? summary.totalMs / summary.count : 0;
          lines.push(
            [
              name,
              `count=${summary.count}`,
              `totalMs=${summary.totalMs.toFixed(1)}`,
              `avgMs=${avgMs.toFixed(1)}`,
              `maxMs=${summary.maxMs.toFixed(1)}`,
              `errors=${summary.errorCount}`,
              `cancels=${summary.cancelCount}`,
            ].join(' '),
          );
        });
    }

    return `${lines.join('\n')}\n`;
  }

  private pushEntry(entry: Omit<PerfLogEntry, 'id'>) {
    this.entries.push({
      id: this.nextId,
      ...entry,
    });
    this.nextId += 1;

    if (this.entries.length > MAX_PERF_LOG_ENTRIES) {
      this.entries = this.entries.slice(-MAX_PERF_LOG_ENTRIES);
    }

    this.notifyListeners();
  }

  private notifyListeners() {
    if (this.isListenerNotificationQueued) {
      return;
    }

    // Perf events can be recorded during render for instrumentation; flush
    // subscribers asynchronously so React doesn't see cross-component setState.
    this.isListenerNotificationQueued = true;
    Promise.resolve().then(() => {
      this.isListenerNotificationQueued = false;
      const data = this.getLogData();
      this.listeners.forEach(listener => listener(data));
    });
  }

  private getSensitiveAlias(kind: SensitiveAliasKind, rawValue: string): string {
    const normalizedValue = String(rawValue || '');
    if (!normalizedValue) {
      return normalizedValue;
    }

    const existingAlias = this.sensitiveAliasMaps[kind].get(normalizedValue);
    if (existingAlias) {
      return existingAlias;
    }

    this.sensitiveAliasCounts[kind] += 1;
    const alias = `[${kind}_${this.sensitiveAliasCounts[kind]}]`;
    this.sensitiveAliasMaps[kind].set(normalizedValue, alias);
    return alias;
  }

  private redactKnownIdsInString(rawValue: string): string {
    let nextValue = rawValue;

    (Object.keys(this.sensitiveAliasMaps) as SensitiveAliasKind[]).forEach(
      kind => {
        this.sensitiveAliasMaps[kind].forEach((alias, original) => {
          nextValue = replaceAll(nextValue, original, alias);
        });
      },
    );

    return nextValue;
  }

  private redactAddressLikeStrings(rawValue: string): string {
    let nextValue = rawValue;
    const matches = new Set<string>();

    ADDRESS_LIKE_PATTERNS.forEach(pattern => {
      const patternMatches = nextValue.match(pattern) || [];
      patternMatches.forEach(match => {
        if (match) {
          matches.add(match);
        }
      });
    });

    Array.from(matches)
      .sort((a, b) => b.length - a.length)
      .forEach(match => {
        nextValue = replaceAll(
          nextValue,
          match,
          this.getSensitiveAlias('address', match),
        );
      });

    return nextValue;
  }

  private redactKeyLikeStrings(rawValue: string): string {
    return rawValue.replace(
      /\b(chartLifecycleKey|visibleKeyIdsSig):([^\s]+)/g,
      (_match, fieldName: string, fieldValue: string) => {
        const redactedFieldValue = String(fieldValue || '')
          .split('->')
          .map(segment => {
            const normalizedSegment = String(segment || '');
            if (
              !normalizedSegment ||
              normalizedSegment === 'null' ||
              normalizedSegment === 'undefined'
            ) {
              return normalizedSegment;
            }

            return this.getSensitiveAlias('key', normalizedSegment);
          })
          .join('->');

        return `${fieldName}:${redactedFieldValue}`;
      },
    );
  }

  private sanitizePerfMetadataValue(key: string | undefined, value: unknown): unknown {
    if (value == null) {
      return value;
    }

    const normalizedKey = key ? normalizeMetadataKey(key) : '';

    if (Array.isArray(value)) {
      if (ADDRESS_KEY_NAMES.has(normalizedKey)) {
        return value.map(item =>
          this.getSensitiveAlias('address', String(item || '')),
        );
      }

      if (WALLET_ID_KEY_NAMES.has(normalizedKey)) {
        return value.map(item =>
          this.getSensitiveAlias('wallet', String(item || '')),
        );
      }

      if (KEY_ID_KEY_NAMES.has(normalizedKey)) {
        return value.map(item => this.getSensitiveAlias('key', String(item || '')));
      }

      if (TRANSACTION_ID_KEY_NAMES.has(normalizedKey)) {
        return value.map(item =>
          this.getSensitiveAlias('transaction', String(item || '')),
        );
      }

      return value.map(item => this.sanitizePerfMetadataValue(undefined, item));
    }

    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([nestedKey, nestedValue]) => [
            nestedKey,
            this.sanitizePerfMetadataValue(nestedKey, nestedValue),
          ],
        ),
      );
    }

    if (WALLET_ID_KEY_NAMES.has(normalizedKey)) {
      return this.getSensitiveAlias('wallet', String(value));
    }

    if (KEY_ID_KEY_NAMES.has(normalizedKey)) {
      return this.getSensitiveAlias('key', String(value));
    }

    if (ADDRESS_KEY_NAMES.has(normalizedKey)) {
      return this.getSensitiveAlias('address', String(value));
    }

    if (TRANSACTION_ID_KEY_NAMES.has(normalizedKey)) {
      return this.getSensitiveAlias('transaction', String(value));
    }

    if (SCOPE_KEY_NAMES.has(normalizedKey)) {
      return this.getSensitiveAlias('scope', String(value));
    }

    if (SNAPSHOT_SIG_KEY_NAMES.has(normalizedKey)) {
      return this.getSensitiveAlias('snapshot_sig', String(value));
    }

    if (REVISION_KEY_NAMES.has(normalizedKey)) {
      return this.getSensitiveAlias('revision', String(value));
    }

    if (typeof value === 'string') {
      return this.redactKeyLikeStrings(
        this.redactAddressLikeStrings(this.redactKnownIdsInString(value)),
      );
    }

    return value;
  }

  private sanitizePerfMetadata(metadata?: PerfMetadata): PerfMetadata | undefined {
    const sanitizedMetadata = sanitizeMetadata(metadata);
    if (!sanitizedMetadata) {
      return undefined;
    }

    return Object.fromEntries(
      Object.entries(sanitizedMetadata).map(([key, value]) => [
        key,
        this.sanitizePerfMetadataValue(key, value),
      ]),
    );
  }
}

export const perfLogger = PerfLogger.getInstance();

export const clearPerfLogs = () => perfLogger.clear();
export const formatPerfLogsForExport = (metadata?: PerfMetadata) =>
  perfLogger.formatForExport(metadata);
export const getPerfClockNowMs = () => perfLogger.getClockNowMs();
export const measurePerfAsync = async <T>(
  name: string,
  callback: () => Promise<T>,
  metadata?: PerfMetadata,
): Promise<T> => {
  const span = perfLogger.startSpan(name, metadata);

  try {
    const result = await callback();
    span.finish();
    return result;
  } catch (error) {
    span.fail(error);
    throw error;
  }
};
export const measurePerfSync = <T>(
  name: string,
  callback: () => T,
  metadata?: PerfMetadata,
): T => {
  const span = perfLogger.startSpan(name, metadata);

  try {
    const result = callback();
    span.finish();
    return result;
  } catch (error) {
    span.fail(error);
    throw error;
  }
};
export const recordPerfEvent = (name: string, metadata?: PerfMetadata) =>
  perfLogger.recordEvent(name, metadata);
export const startPerfSpan = (name: string, metadata?: PerfMetadata) =>
  perfLogger.startSpan(name, metadata);
