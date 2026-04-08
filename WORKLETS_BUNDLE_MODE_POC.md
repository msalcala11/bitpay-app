# Worklets Bundle Mode POC

This repo includes a minimal proof of concept that uses `react-native-worklets` Bundle Mode to perform repeated signed wallet `txhistory` requests on a dedicated worker runtime.

## What changed

- Enabled Worklets Bundle Mode in `babel.config.js`.
- Enabled Worklets Bundle Mode Metro wiring in `metro.config.js`.
- Enabled the `FETCH_PREVIEW_ENABLED` static feature flag in `package.json`.
- Added Worklets Bundle Mode allow-list entries for the signing dependencies used on the worker runtime:
  - `@bitpay-labs/crypto-wallet-core`
  - `buffer`
  - `process`
  - `crypto`
  - `react-native-quick-crypto`
- Updated the demo screen at:
  - `Settings -> About BitPay -> Worklets TxHistory Demo`
- Replaced the simple rates fetch with a worker-side wallet txhistory request flow that:
  - selects a wallet already present in app state
  - primes that wallet's txhistory request context into the worker runtime once
  - builds a BWS-compatible `/v1/txhistory/` request path inside the worker for every page
  - signs every request inside the worker runtime using the wallet's `requestPrivKey`
  - sends every request from the same worker via `fetch`
  - can fetch multiple txhistory pages in one worker-side batch without asking the RN runtime to build each page request

## Runtime demo files

- `src/lib/workletsBundleModeDemo.ts`
- `src/navigation/tabs/settings/about/screens/WorkletsBundleModeDemo.tsx`
- `src/navigation/tabs/settings/about/AboutGroup.tsx`
- `src/navigation/tabs/settings/components/About.tsx`
- `babel.config.js`

## Notes about the txhistory request

- This iteration intentionally **does not** call `wallet.getTxHistory()` from the worker runtime.
- Instead, it mirrors the relevant BWC request behavior for this specific PoC:
  - wallet session priming on the worker
  - request path construction for `/v1/txhistory/`
  - BWS `GET` signing format
  - worker-side `fetch`
  - repeated page fetches in a single worker task
- The selected wallet's request credentials are copied into the worker runtime once when the session is primed.
- Subsequent page requests are built and signed from worker-held state.
- The screen only displays a short signature preview and never displays the private key.

## Dependency updates

- `react-native-worklets`: `0.8.1`
- `react-native-reanimated`: `4.1.7`

## Required local setup after unzipping

1. Install JS dependencies:
   - `yarn install`
2. Reinstall iOS pods:
   - `cd ios && bundle exec pod install && cd ..`
3. Start Metro with a cleared cache:
   - `yarn start:reset-cache`
4. Rebuild the native app.

## Notes

- This environment did not install npm packages or CocoaPods, so native lockfiles were not regenerated here.
- The Worklets docs still mention optional Metro / `metro-runtime` patches for the smoothest dev experience. This POC does not add those optional patches.
