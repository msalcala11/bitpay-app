import {type WorkletMmkvStorageBridge} from '../adapters/rn/mmkvKvStore';
import {PORTFOLIO_V2_FLAG_KEY} from './constants';

class FakeMmkv {
  readonly data = new Map<string, string>();

  contains(key: string): boolean {
    return this.data.has(key);
  }

  delete(key: string): void {
    this.data.delete(key);
  }

  getString(key: string): string | undefined {
    return this.data.get(key);
  }

  set(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const mockMmkv = new FakeMmkv();

jest.mock('../adapters/rn/workletMmkvBridge', () => ({
  __esModule: true,
  PORTFOLIO_WORKLET_MMKV_STORAGE_ID: 'bitpay.portfolio.engine',
  PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY:
    '__bitpay.portfolio.engine.registry.v1__',
  getPortfolioMmkvStorageOnRN: () => mockMmkv,
  createPortfolioMmkvStorageOnRN: () => mockMmkv,
  getNativeMmkvStorageBridgeOnRN: () => mockMmkv,
  getPortfolioMmkvNativeStorageOnRN: () => mockMmkv,
}));

// Import AFTER the mock so featureFlag.ts binds the mocked accessor.
import {
  isPortfolioV2EnabledOnJS,
  isPortfolioV2EnabledOnWorklet,
  setPortfolioV2EnabledForTesting,
} from './featureFlag';

class FakeMmkvStorageBridge implements WorkletMmkvStorageBridge {
  readonly data = new Map<string, string>();

  contains(key: string): boolean {
    return this.data.has(key);
  }

  delete(key: string): void {
    this.data.delete(key);
  }

  getString(key: string): string | undefined {
    return this.data.get(key);
  }

  set(key: string, value: string): void {
    this.data.set(key, value);
  }
}

beforeEach(() => {
  mockMmkv.data.clear();
});

describe('PORTFOLIO_V2 feature flag (worklet path)', () => {
  it('returns false when the flag key is absent', () => {
    const bridge = new FakeMmkvStorageBridge();
    expect(isPortfolioV2EnabledOnWorklet(bridge)).toBe(false);
  });

  it("returns true only when the flag value is the literal '1'", () => {
    const bridge = new FakeMmkvStorageBridge();

    bridge.set(PORTFOLIO_V2_FLAG_KEY, '1');
    expect(isPortfolioV2EnabledOnWorklet(bridge)).toBe(true);

    bridge.set(PORTFOLIO_V2_FLAG_KEY, '0');
    expect(isPortfolioV2EnabledOnWorklet(bridge)).toBe(false);

    bridge.set(PORTFOLIO_V2_FLAG_KEY, 'true');
    expect(isPortfolioV2EnabledOnWorklet(bridge)).toBe(false);

    bridge.set(PORTFOLIO_V2_FLAG_KEY, '');
    expect(isPortfolioV2EnabledOnWorklet(bridge)).toBe(false);
  });

  it('returns false after the flag is deleted', () => {
    const bridge = new FakeMmkvStorageBridge();
    bridge.set(PORTFOLIO_V2_FLAG_KEY, '1');
    expect(isPortfolioV2EnabledOnWorklet(bridge)).toBe(true);

    bridge.delete(PORTFOLIO_V2_FLAG_KEY);
    expect(isPortfolioV2EnabledOnWorklet(bridge)).toBe(false);
  });

  it('uses the documented MMKV key', () => {
    expect(PORTFOLIO_V2_FLAG_KEY).toBe('portfolio:v2:flag');
  });
});

describe('PORTFOLIO_V2 feature flag (JS path)', () => {
  it('returns false when the flag key is absent', () => {
    expect(isPortfolioV2EnabledOnJS()).toBe(false);
  });

  it("returns true only when the flag value is the literal '1'", () => {
    mockMmkv.set(PORTFOLIO_V2_FLAG_KEY, '1');
    expect(isPortfolioV2EnabledOnJS()).toBe(true);

    mockMmkv.set(PORTFOLIO_V2_FLAG_KEY, '0');
    expect(isPortfolioV2EnabledOnJS()).toBe(false);

    mockMmkv.set(PORTFOLIO_V2_FLAG_KEY, 'true');
    expect(isPortfolioV2EnabledOnJS()).toBe(false);

    mockMmkv.set(PORTFOLIO_V2_FLAG_KEY, '');
    expect(isPortfolioV2EnabledOnJS()).toBe(false);
  });

  it('returns false after the flag is deleted', () => {
    mockMmkv.set(PORTFOLIO_V2_FLAG_KEY, '1');
    expect(isPortfolioV2EnabledOnJS()).toBe(true);

    mockMmkv.delete(PORTFOLIO_V2_FLAG_KEY);
    expect(isPortfolioV2EnabledOnJS()).toBe(false);
  });
});

describe('setPortfolioV2EnabledForTesting', () => {
  it('writes the literal flag value when enabled', () => {
    setPortfolioV2EnabledForTesting(true);
    expect(mockMmkv.getString(PORTFOLIO_V2_FLAG_KEY)).toBe('1');
    expect(isPortfolioV2EnabledOnJS()).toBe(true);
  });

  it('deletes the flag key when disabled (rather than writing a falsy value)', () => {
    mockMmkv.set(PORTFOLIO_V2_FLAG_KEY, '1');
    setPortfolioV2EnabledForTesting(false);
    expect(mockMmkv.contains(PORTFOLIO_V2_FLAG_KEY)).toBe(false);
    expect(isPortfolioV2EnabledOnJS()).toBe(false);
  });

  it('round-trips through enable/disable cycles', () => {
    setPortfolioV2EnabledForTesting(true);
    expect(isPortfolioV2EnabledOnJS()).toBe(true);

    setPortfolioV2EnabledForTesting(false);
    expect(isPortfolioV2EnabledOnJS()).toBe(false);

    setPortfolioV2EnabledForTesting(true);
    expect(isPortfolioV2EnabledOnJS()).toBe(true);
  });
});
