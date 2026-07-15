# Portfolio shared Worklet Runtime and request-local context

## Architecture

The production portfolio subsystem uses one `react-native-worklets` Worker Runtime. The base portfolio client, fiat-rate client, and analysis client remain separate `PortfolioRuntimeClient` instances, but each transport targets the same runtime returned by `getPortfolioWorkletRuntime()`.

This removes concurrent first materialization of the same retained portfolio worklet graph on independent worker runtimes. The three public runtime getters are retained for compatibility and all return the same object.

## Request-local Nitro and signing state

Nitro Fetch and BWS signing state is owned by the request that created it. A `PortfolioTxHistorySigningDispatchContext` is passed explicitly from the transport through the runtime dispatcher and request handler to every operation that performs Nitro Fetch or transaction-history signing.

The request context is not installed as an ambient runtime-global “current request.” In particular, there is no `__bitpayPortfolioTxHistorySigningContextV1__` pointer. Stable runtime capabilities, such as the installed Nitro Modules proxy, may remain global because they do not select mutable request state.

Each request context may contain:

- boxed Nitro Modules and Nitro Fetch handles;
- a lazily created Nitro Fetch client;
- the minimal derived SEC1 signing authority needed for BWS signing;
- hydrated native signing handles and that context’s independent handle cursor.

Raw `requestPrivKey` values are still consumed on the React Native host. They are not copied into runtime requests or logs. The derived signing authority is deleted as soon as native signing handles are hydrated.

## Ownership and cleanup

A foreground dispatch owns its context until the runtime reports a terminal response or fatal error. The JS transport keeps the source context in an in-flight set and releases it exactly once from the terminal callback, scheduling failure path, or transport teardown. The runtime copy is released after the request handler reaches a terminal result.

A background populate job clones the minimal per-wallet context at job start and owns those clones. Prepare/rate work receives a temporary fetch-only view. Transaction-history page work receives the signing-capable wallet context directly. Wallet contexts are isolated, and each is disposed after wallet completion or failure; all remaining contexts are disposed when the job completes, fails, is cancelled, or is reset.

Cancellation does not dispose a context that is still used by an in-flight page request. The job marks cancellation, waits for that operation to return, closes the wallet session, and then performs terminal cleanup.

## Regression coverage

Focused tests cover:

- identity of all three production runtime getters and a single runtime creation;
- separate clients targeting the same runtime;
- overlapping shared-runtime dispatches retaining their own explicit contexts after yielding;
- Nitro Fetch client isolation and independent signing-handle cursors;
- missing and fetch-only context failures;
- idempotent context disposal;
- foreground context lifetime through terminal callbacks, scheduling errors, and transport teardown;
- per-wallet background job context isolation;
- fetch-only prepare contexts preserving job-owned signing authority;
- cancellation and reset cleanup.
