# Worklets Bundle Mode POC

This branch enables `react-native-worklets` Bundle Mode and includes a proof of concept that performs repeated signed wallet `txhistory` requests on a dedicated worker runtime.

The most important thing to keep in mind is that Bundle Mode is global for the app build. Even though the new feature is a worker-runtime demo, turning Bundle Mode on changes how worklets are built and loaded for the RN runtime, UI runtime, and worker runtimes.

## Change buckets

### 1. Global app/runtime changes

These changes are needed so the existing app keeps working once Bundle Mode is enabled anywhere in the build.

- Enabled Worklets Bundle Mode in `babel.config.js`.
- Enabled Worklets Bundle Mode Metro wiring in `metro.config.js`.
- Enabled the `FETCH_PREVIEW_ENABLED` static feature flag in `package.json`.
- Added startup bootstrap in `index.js` to mirror `SkiaApi` and `SkiaViewApi` from the RN runtime to the UI runtime.
- Added patch-package patches required for Bundle Mode compatibility:
  - `patches/metro+0.83.1.patch`
  - `patches/react-native-worklets+0.8.1.patch`
  - `patches/@shopify+react-native-skia+2.2.13.patch`
  - `patches/react-native-graph+1.1.0.patch`

### 2. Demo-only changes

These files are specific to the worker-runtime signing/fetch proof of concept.

- `src/lib/workletsBundleModeDemo.ts`
- `src/navigation/tabs/settings/about/screens/WorkletsBundleModeDemo.tsx`
- `src/navigation/tabs/settings/about/AboutGroup.tsx`
- `src/navigation/tabs/settings/components/About.tsx`

## Why the app/runtime changes exist

### Metro + Worklets

- `metro.config.js` adds the official Worklets Bundle Mode Metro config and keeps the app's custom resolver aliases working.
- `patches/metro+0.83.1.patch` is the Metro SHA-1 workaround required for generated `.worklets/*` files.
- `patches/react-native-worklets+0.8.1.patch` includes the runtime fixes we needed in practice:
  - correct Metro mock module registration (`factory`, not `moduleFactory`)
  - safer `require` / `globalThis.__r` fallback handling
  - worker-only networking bootstrap
  - Android bundle download handling for large debug bundles
  - Bundle Mode release/runtime initialization fixes

### Skia + react-native-graph

Bundle Mode exposed two separate chart/runtime issues:

- Skia installed `SkiaApi` and `SkiaViewApi` into the RN runtime, but not automatically into the Worklets UI runtime.
- `react-native-graph` worklet helpers imported some symbols from the Skia package root, which pulled extra RN-side Skia setup into generated worklets.

The fixes are:

- `index.js`
  - explicitly mirrors the Skia host objects into the UI runtime once at startup
- `patches/@shopify+react-native-skia+2.2.13.patch`
  - switches Skia runtime access from bare globals like `SkiaViewApi` to `globalThis.SkiaViewApi`
- `patches/react-native-graph+1.1.0.patch`
  - rewrites the worklet-bearing graph helpers to import worklet-safe Skia internals instead of the package root

These are app-stability fixes, not demo-only fixes.

## Demo behavior

The demo intentionally does not call `wallet.getTxHistory()` from the worker runtime.

Instead, it mirrors the relevant BWC behavior needed for the PoC:

- select a wallet already present in app state
- prime that wallet's request context into the worker runtime once
- build BWS-compatible `/v1/txhistory/` request paths inside the worker
- sign requests in the worker runtime
- perform `fetch` from the same worker runtime
- batch multiple page requests without returning to the RN runtime for every page

The selected wallet's request credentials are copied into the worker runtime once when the session is primed. The screen only displays short signature/request diagnostics and never displays the private key.

## Worklet allow-list

The Bundle Mode allow-list in `babel.config.js` is only for the worker signing/fetch PoC:

- `@bitpay-labs/bitcore-lib`
- `@bitpay-labs/crypto-wallet-core`
- `buffer`
- `process`
- `crypto`
- `react-native-quick-crypto`

Those entries are demo-driven, unlike the Skia/graph/runtime patches above.

## Dependency versions

- `react-native-worklets`: `0.8.1`
- `react-native-reanimated`: `4.1.7`

## Required local setup

1. Install JS dependencies:
   - `yarn install`
2. Reinstall iOS pods:
   - `cd ios && bundle exec pod install && cd ..`
3. Start Metro with a cleared cache:
   - `yarn start --reset-cache`
4. Rebuild the native app.

## Current takeaway

If Bundle Mode stays enabled in this app, the Metro / Worklets / Skia / graph compatibility fixes should be treated as app-level infrastructure. The txhistory demo itself is only a small subset of the overall diff.
