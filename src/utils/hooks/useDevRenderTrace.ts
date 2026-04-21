import {useCallback, useEffect, useRef} from 'react';
import type {LayoutChangeEvent} from 'react-native';

type RenderTraceValues = Record<string, unknown>;

type UseDevRenderTraceOptions = {
  enabled?: boolean;
  includeMount?: boolean;
  includeUnmount?: boolean;
};

type UseDevLayoutTraceOptions = {
  enabled?: boolean;
};

type GlobalRenderTraceConfig =
  | boolean
  | string
  | string[]
  | {
      include?: string[];
      exclude?: string[];
    };

const DEFAULT_ENABLED_TRACE_NAMES = new Set([
  'HomeRoot',
  'AssetsSection',
  'HomeAssetsSectionLayout',
  'AssetsList',
  'HomeAssetsListLayout',
  'usePortfolioAssetRows',
  'HomeRootLinkingButtons',
  'HomeRootLinkingButtons:layout',
  'AssetDetails',
  'useExchangeRateSharedModel',
  'usePortfolioWalletSnapshotPresence',
  'AssetBalanceHistoryScreen',
  'AssetBalanceChartSection',
  'AssetBalanceChartSectionLayout',
  'ExchangeRateScreenLayout',
  'AssetDetailsActionsLayout',
  'AssetDetailsLinkingButtons',
  'AssetDetailsLinkingButtons:layout',
]);

function getGlobalRenderTraceConfig(): GlobalRenderTraceConfig | undefined {
  return (globalThis as typeof globalThis & {
    __BITPAY_RENDER_TRACE__?: GlobalRenderTraceConfig;
  }).__BITPAY_RENDER_TRACE__;
}

function matchesTraceName(pattern: string, name: string): boolean {
  return name === pattern || name.includes(pattern);
}

function isTraceEnabled(name: string, enabled?: boolean): boolean {
  if (!__DEV__) {
    return false;
  }

  const config = getGlobalRenderTraceConfig();
  if (process.env.NODE_ENV === 'test' && config == null) {
    return false;
  }

  if (typeof enabled === 'boolean') {
    return enabled;
  }

  if (config === false) {
    return false;
  }

  if (config === true) {
    return true;
  }

  if (typeof config === 'string') {
    return matchesTraceName(config, name);
  }

  if (Array.isArray(config)) {
    return config.some(pattern => matchesTraceName(pattern, name));
  }

  if (config && typeof config === 'object') {
    const exclude = Array.isArray(config.exclude) ? config.exclude : [];
    if (exclude.some(pattern => matchesTraceName(pattern, name))) {
      return false;
    }

    const include = Array.isArray(config.include) ? config.include : [];
    if (include.length) {
      return include.some(pattern => matchesTraceName(pattern, name));
    }
  }

  return DEFAULT_ENABLED_TRACE_NAMES.has(name);
}

function summarizeTraceValue(value: unknown): unknown {
  if (value == null) {
    return value;
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return value;
  }

  if (typeof value === 'string') {
    return value.length > 180 ? `${value.slice(0, 177)}...` : value;
  }

  if (Array.isArray(value)) {
    if (!value.length) {
      return [];
    }

    const sample = value.slice(0, 4).map(entry => summarizeTraceValue(entry));
    return value.length > 4
      ? {
          type: 'array',
          length: value.length,
          sample,
        }
      : sample;
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);

    if (
      keys.length === 4 &&
      ['height', 'width', 'x', 'y'].every(key => keys.includes(key))
    ) {
      const layout = value as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      return {
        x: Number(layout.x.toFixed(1)),
        y: Number(layout.y.toFixed(1)),
        width: Number(layout.width.toFixed(1)),
        height: Number(layout.height.toFixed(1)),
      };
    }

    return keys.length > 6
      ? {
          type: 'object',
          keys: keys.slice(0, 6),
          extraKeys: keys.length - 6,
        }
      : {
          type: 'object',
          keys,
        };
  }

  return String(value);
}

function buildTraceSnapshot(values: RenderTraceValues): RenderTraceValues {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      summarizeTraceValue(value),
    ]),
  );
}

function buildTraceChanges(
  prev: RenderTraceValues | undefined,
  next: RenderTraceValues,
): Record<string, {prev: unknown; next: unknown}> {
  if (!prev) {
    return {};
  }

  const keys = Array.from(
    new Set([...Object.keys(prev), ...Object.keys(next)]),
  ).sort();

  return keys.reduce<Record<string, {prev: unknown; next: unknown}>>(
    (changes, key) => {
      if (Object.is(prev[key], next[key])) {
        return changes;
      }

      changes[key] = {
        prev: summarizeTraceValue(prev[key]),
        next: summarizeTraceValue(next[key]),
      };

      return changes;
    },
    {},
  );
}

export function useDevRenderTrace(
  name: string,
  values: RenderTraceValues,
  options: UseDevRenderTraceOptions = {},
): void {
  const enabled = isTraceEnabled(name, options.enabled);
  const prevValuesRef = useRef<RenderTraceValues | undefined>(undefined);
  const commitCountRef = useRef(0);
  const lastCommitAtRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    commitCountRef.current += 1;
    const now = Date.now();
    const prevValues = prevValuesRef.current;
    const elapsedMs =
      lastCommitAtRef.current == null ? 0 : now - lastCommitAtRef.current;
    const changes = buildTraceChanges(prevValues, values);

    if (!prevValues) {
      if (options.includeMount !== false) {
        console.log(`[render-trace] ${name} mount`, {
          commit: commitCountRef.current,
          values: buildTraceSnapshot(values),
        });
      }
    } else if (Object.keys(changes).length) {
      console.log(`[render-trace] ${name} commit`, {
        commit: commitCountRef.current,
        elapsedMs,
        changes,
      });
    }

    prevValuesRef.current = values;
    lastCommitAtRef.current = now;
  });

  useEffect(() => {
    if (!enabled || options.includeUnmount === false) {
      return;
    }

    return () => {
      console.log(`[render-trace] ${name} unmount`, {
        commit: commitCountRef.current,
        values: buildTraceSnapshot(prevValuesRef.current || {}),
      });
    };
  }, [enabled, name, options.includeUnmount]);
}

export function useDevLayoutTrace(
  name: string,
  options: UseDevLayoutTraceOptions = {},
): ((event: LayoutChangeEvent) => void) | undefined {
  const enabled = isTraceEnabled(name, options.enabled);
  const prevLayoutRef = useRef<
    | {
        x: number;
        y: number;
        width: number;
        height: number;
      }
    | undefined
  >(undefined);

  return useCallback(
    (event: LayoutChangeEvent) => {
      if (!enabled) {
        return;
      }

      const nextLayout = {
        x: Number(event.nativeEvent.layout.x.toFixed(1)),
        y: Number(event.nativeEvent.layout.y.toFixed(1)),
        width: Number(event.nativeEvent.layout.width.toFixed(1)),
        height: Number(event.nativeEvent.layout.height.toFixed(1)),
      };
      const prevLayout = prevLayoutRef.current;

      if (
        !prevLayout ||
        prevLayout.x !== nextLayout.x ||
        prevLayout.y !== nextLayout.y ||
        prevLayout.width !== nextLayout.width ||
        prevLayout.height !== nextLayout.height
      ) {
        console.log(`[layout-trace] ${name}`, {
          prev: prevLayout,
          next: nextLayout,
        });
      }

      prevLayoutRef.current = nextLayout;
    },
    [enabled, name],
  );
}

export default useDevRenderTrace;
