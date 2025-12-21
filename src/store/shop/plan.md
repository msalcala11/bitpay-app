
Components we want to add to this app


Charts
Fiat value charts for wallets, accounts (aggregations of evm wallets), keys (aggregations of all wallets), and the portfolio as a whole (all keys and their wallets). These charts display the fiat value of the crypto held in a wallet, account, key, or portfolio over the following intervals: day, week, month, 3 months, 1 year, 5 years, and all time. The charts will also display the breakeven line (cost basis) as a dotted horizontal line at the current remaining cost basis (now) converted into the currently selected altCurrency (via an FX layer). We’ll also need to compute the PnL for each wallet/account/key/portfolio over all 7 intervals.

We already have PriceCharts which show the exchange rate of a crypto asset over time over 3 intervals: day, week, and month. We will be adding the additional intervals above: 3 months, 1 year, 5 years, and all time. We will also display a breakeven line on each price chart at the exchange rate at which the balances of the selected crypto across all wallets in the app are at breakeven in terms of unrealized PnL over the selected interval.

Asset list

We will display a list of unique assets owned by the user across all wallets and keys in the app. This list will show the aggregate amount in crypto of the asset owned as well as the current fiat value of the crypto in the selected altCurrency. Additionally the user will be able to see the unrealized PnL of each asset over the same intervals used for the charts: day, week, month, 3 months, 1 year, 5 years, and all time (the user will select which interval they want to view via a dropdown selector). We’ll also show what percentage of the overall portfolio that particular asset constitutes in terms of the selected altCurrency.

We’ll need to be able to compute an asset allocation for each key and the portfolio as a whole.

To get the aggregate crypto amount and fiat value, we can simply sum all wallet balances by asset. To get the PnL, we’ll need the entire transaction history of every wallet.

We also want to add a “Portfolio” item to @StorageUsage.tsx to track how much on device storage we’re using for all of this portfolio data.

FAQs
Cost basis calculation: average cost, but let’s try to architect things so that it wouldn’t be hard to add support for the other types of  cost basis methods if needed
Fees: Treated as part of the crypto disposed during a move or a send
Transfers between own wallets and keys excluded?: For simplicity sake, let’s go with no but maybe we can add a filter later.
EVM Token coverage: yes, in this app every EVM token is it’s own “wallet”


Action plan:


Step 1. Computing wallet balances, cost-basis, and unrealized PnL for each wallet

Write code to fetch full transaction history per wallet:

fetchFullTransactionHistory

	calls getTxHistory with 1000 as the limit until it gets no more. 
	for each tx returned, normalize into a PortfolioTxEvent and (when needed for cost basis) fetch an asset->USD historical price to persist alongside the event for deterministic recomputation

Saves normalized transactions and derived state into a new PORTFOLIO store in redux.

PortfolioTxEvent interface (persisted)
	- walletId
	- txid
	- time
	- assetId (coin or token)
	- category: receive | spend | moved
	- cryptoDelta (signed)
	- feeCrypto (if applicable)
	- confirmed/status
	- usdPriceUsed? (asset->USD at tx time; required for events that create cost basis)
	- basisUSDOverride? (future support: user-provided basis)
	- counterpartyWalletId? (optional, for moves)

Derived per-wallet state (persisted)
	- lightweight checkpoints to speed up historical lookups (e.g. periodic every N txs and/or daily)
	- checkpoints are used instead of storing running balance/cost basis fields on every PortfolioTxEvent to reduce storage size and make derived state easier to rebuild if logic changes
	- current cached values per wallet: cryptoBalance, costBasisRemainingUSD, unrealizedPnLUSD

WalletPositionCheckpoint interface (persisted)
	- walletId
	- time
	- txIndex (index into wallet's PortfolioTxEvent list)
	- cryptoBalance
	- costBasisRemainingUSD
	- avgCostUSDPerUnit

WalletIntervalCursor interface (persisted)
	- walletId
	- interval: day | week | month | 3months | year | 5years | all
	- lastEndTime (end timestamp for the last computed 45-point series on the standardized grid)
	- lastTxIndex (index into wallet's PortfolioTxEvent list at lastEndTime)
	- cryptoBalance
	- costBasisRemainingUSD

Cursor cardinality
	- expected count is approximately: (number of wallets with tx history) * (7 intervals)
	- each cursor item is small, so hundreds to low-thousands of cursor rows should be acceptable
	- if needed, we can reduce cursor count by only persisting cursors for intervals the user has viewed recently

Accounting rules
	- USD is canonical for cost basis and PnL. Selected altCurrency is displayed via a separate USD->ALT FX cache.
	- average cost basis
	- fees treated as part of the crypto disposed during a move or send
	- moved direction is inferred from cryptoDelta (positive = moved_in, negative = moved_out)
	- for moved (cryptoDelta > 0), usdPriceUsed is a v1 fallback for basis assignment if basis transfer cannot be determined

Testing

Add a “Transaction History Debug” item to each wallet settings bottom sheet that links to a screen that shows:

1. PortfolioTxEvent list for the wallet + derived checkpoint summaries (crypto balance + costBasisRemainingUSD over time)
2. Add an export button that copies to clipboard all of the data above in csv format
3. Add a “Portfolio” item to @StorageUsage.tsx to track how much on device storage we’re using for all of this portfolio data

This will allow us to compute the current cost basis, and unrealized PnL over any interval. We’ll cache the current cost basis for every wallet until it is invalidated via a new transaction.


Step 2. Aggregation of PnL across wallets

We need to aggregate cost basis and unrealized PnL across wallets for keys, accounts, assets and the portfolio as a whole. Luckily, cost basis is easily summable across wallets, same with the fiat balance of each wallet. This will allow us to show the PnL tables by asset, and the PnL of each key, account, and portfolio.

PnL over an interval is defined as the change in unrealized PnL:
	UnrealizedPnLUSD(t) = ValueUSD(t) - CostBasisRemainingUSD(t)
	IntervalPnLUSD = UnrealizedPnLUSD(end) - UnrealizedPnLUSD(start)

This should be performant using checkpoints from step 1 to obtain CostBasisRemainingUSD(t) and cryptoBalance(t) at the start/end timestamps, then computing ValueUSD(t) using crypto->USD rates.

After step 2, we should be fully ready to implement all non-chart UI elements of the portfolio enhancements (asset allocation chart, and asset unrealized PnL list)

Step 3. Build a rate cache for the 7 intervals for every used cryptocurrency 

buildRateCache

For every wallet with transaction history we need intermediate rates between transactions for chart purposes. Let’s target exactly 45 points per chart as this seems to be the maximum number of data points at which react-native-graph reliably animates the graph when changing intervals and it needs the intervals to have an equal number of data points to do so:

We need the following intervals:

Day 
Week
Month
3 Months
Year
5 years 
All time (life of the wallet)

We need to compute the sampling rate for rates for each interval to get 45 points per chart (315 for all intervals)

5 years, ~every 40 days
Year, ~every 8 days
3 months, ~every 2 days
Month, ~every 16 hrs,
….
All time (variable) (wallet lifetime / 45)

In order to be able to aggregate chart data across wallets, we’ll need standardized timestamps for rates (and fiat values) for each interval. Then we can just sum the same timestamps for all aggregated wallets to produce that aggregate charts.

We’ll store crypto->USD rates for every unique cryptocurrency we have, and separately store a USD->ALT FX cache. When the user changes the altCurrency, charts can be derived immediately once FX for that altCurrency exists (or temporarily show the previous altCurrency until FX backfills).

Refreshes will remove any data points that are too old and fill in data points for the most recent timestamps (not refill everything from scratch)

Step 4. Compute wallet fiat balance values at each of the standard rate cache timestamps for all 7 intervals

Data point (USD): getCryptoBalanceAtTimestamp(portfolioTxEvents/checkpoints, timestamp) * cryptoUsdRateCache(timestamp)
Data point (ALT): DataPointUSD * usdAltFxCache(timestamp)

Step 5. Aggregate wallet fiat balances across wallets to build chart data for keys, account, and the portfolio as a whole, simply by summing the data points together via the formula above.

We’ll cache the USD balances for each wallet, account, key, and the portfolio as a whole at each of the 7 intervals, and derive/cache ALT series using the USD->ALT FX cache.

Refreshing requires simply shifting data points leftward and replacing missing ones as needed by filling the rate cache and refreshing transaction history.