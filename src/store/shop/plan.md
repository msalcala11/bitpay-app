
Components we want to add to this app


Charts
Fiat value charts for wallets, accounts (aggregations of evm wallets), keys (aggregations of all wallets), and the portfolio as a whole (all keys and their wallets). These charts display the fiat value of the crypto held in a wallet, account, key, or portfolio over the following intervals: day, week, month, 3 months, 1 year, 5 years, and all time. The charts will also display the breakeven line (cost basis) as a dotted horizontal line across the chart intersecting the point in the chart at which the fiat value of the crypto is at breakeven (meaning the unrealized PnL of the crypto remaining is $0) over the selected interval. The charts can be denominated in any altCurrency selected in app settings. We’ll also need to compute the PnL for each wallet/account/key/portfolio over all 7 intervals.

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
	for each getTxHistory call, make a getHistoricalRate request for that timestamp and save it to a map, keyed by currency on the tx so that when a new alt currency is selected in settings, we can continue to show the previously selected currency until the next one backfills in the map (we’ll store both at the same time to make switching alt currencies instantaneous)

Saves the transactions to a walletRunningBalance key in a new PORTFOLIO store in redux.

WalletRunningBalanceItem interface: (crypto delta, type (moved, received, sent), txid, fee, new crypto balance, fiat rates and running cost basis keyed buy selected fiat currency in app settings). We can also make it possible for the user to enter their own cost basis for each tx down the road

Testing

Add a “Transaction History Debug” item to each wallet settings bottom sheet that links to a screen that shows:

1. walletRunningBalance: All transactions in the wallet: (crypto delta, type (moved, received, sent), txid, fee, new crypto balance, fiat rates and running cost basis keyed buy selected fiat currency in app settings). We can also make it possible for the user to enter their own cost basis for each tx down the road
2. Add an export button that copies to clipboard all of the data above in csv format
3. Add a “Portfolio” item to @StorageUsage.tsx to track how much on device storage we’re using for all of this portfolio data

This will allow us to compute the current cost basis, and unrealized PnL over any interval. We’ll cache the current cost basis for every wallet until it is invalidated via a new transaction.


Step 2. Aggregation of PnL across wallets

We need to aggregate cost basis and unrealized PnL across wallets for keys, accounts, assets and the portfolio as a whole. Luckily, cost basis is easily summable across wallets, same with the fiat balance of each wallet. This will allow us to show the PnL tables by asset, and the PnL of each key, account, and portfolio.

This is easiest for all-time PnL (summing cached values), but for 1 day PnL, we’ll need to recompute the cost basis for each wallet yesterday as well as the fiat value of each wallet yesterday to compute the PnL yesterday, then subtract it from today’s PnL to get the PnL change over the past day. This should be performant if we can just look up the running cost basis stored in step 1 above for any given timestamp.

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

We’ll store these for every unique cryptocurrency we have, keyed by alt fiat currency, so that when the user changes the alt fiat currency, we can continue to show charts in the old currency until rates for the newly selected currency backfill. Then if they switch back to the original fiat currency, the switch should be instant.

Refreshes will remove any data points that are too old and fill in data points for the most recent timestamps (not refill everything from scratch)

Step 4. Compute wallet fiat balance values at each of the standard rate cache timestamps for all 7 intervals

Data point: getCryptoBalanceAtTimestamp(walletRunningBalance, timestamp) * fiatRateCache(timestamp)

Step 5. Aggregate wallet fiat balances across wallets to build chart data for keys, account, and the portfolio as a whole, simply by summing the data points together via the formula above.

We’ll cache the fiat balances for each wallet, account, key, and the portfolio as a whole, keyed by alt fiat currency at each of the 7 intervals.

Refreshing requires simply shifting data points leftward and replacing missing ones as needed by filling the rate cache and refreshing transaction history.