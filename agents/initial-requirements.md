All portfolio calculations including snapshot aggregation and population and historical balance chart and PnL calculations must happen off the JS thread in a worklet runtime. This is critical to ensure that the UI never slows down due to portfolio math. Portfolio rates, snapshots, and any other large pieces of data that must not be stored in the Redux but rather in MMKV since anything persisted in Redux is stored in a single MMKV key and any write to Redux must then necessarily include that data which can really slow things down for large data. So the only data that should be stored in Redux is small cached data to help with instantly rendering UI.

The primary renderable outputs of the portfolio runtime are historical fiat balance chart data points over seven intervals with each point containing the timestamp, the fiat value, and the remaining unrealized PL so that all three values are scrubbable with a long press and drag across the chart and update the values at the top of the chart.

Additionally, the Asset List displays a subset of this aforementioned renderable data, which is just the PnL across the one-day interval and the all-time interval, which can be thought of as a special case of those intervals’ respective chart data with just the starting and ending point in the list. It is also possible to navigate to asset list from key overview. In that case, all assets and PL values calculated need to be scoped to that key including the list of wallets shown in asset details when tapping on the asset list item. Asset list items are collapsed under a single ticker across all networks and chains. So USDC, for example, on Ethereum, Polygon, and Solana are all represented as a single asset in the asset list. And all wallets within that asset item need to be aggregated in asset details when displaying historical balance charts and PL values.

This mental model is important because tapping on an asset list item takes you into asset details and immediately shows you the one day balance chart, along with the PL change and percentage over the past day, which needs to exactly match the PL change and percentage shown on the asset list item on the previous screen.  The same is true for the all-time interval. Those two pnl values must also match exactly between the asset list and the balance chart.

The window chosen for computing the PL and the chart data points for each asset must also exactly match the window displayed in the exchange rate screen for that asset, so that if there are no transactions in the one day time frame for a particular asset, the PnL percentage change over the one day interval must exactly match the exchange rate percentage change for that asset over that same interval.  This must also continue to remain true if the user switches their fiat currency in settings. All charts and asset list items need to update to the newly selected currency instantly via an FX bridge through BTC ( No need to fetch rates for all assets in the new currency. Simply fetch BTC rates in the new currency and use that as an FX bridge to compute through the old currency.)

If any navigations to a particular screen cause the rates to update and therefore the PnL percentage change to update on that screen, all other screens displaying that asset in that time frame must also automatically update so that there are no stale out of date numbers as you navigate throughout the app And all screens displaying a particular asset are always consistent in the fiat values and PL changes that they display at all times.

When initial populate happens for the first time for a user and isn't yet complete, balance charts should be hidden initially throughout the app  and only shown on screens for which populate has finished. For example, the first ever renderable balance chart will be the one that lives inside of WalletDetails for the first wallet for which populate was completed. Asset lists should be visible during that populate, and all assets should be shown, and the order in which they're shown must exactly match the order displayed in the allocation screen. The right side of each asset item should initially start with skeleton loaders.And the pop populate process on the worklet should handle one wallet at a time, starting with the highest fiat value wallet within the highest fiat value asset group and continuing downward in fiat value across wallets and then assets from there.The goal is for the asset list to incrementally reveal asset PnL as it is completed by the populate task in the worklet. If a user taps to navigate to all assets from the asset list section in home root, mid-populate, any assets for which PL has already been computed should immediately be visible with that PnL shown in all assets to create the sense of continuity between the short asset list in home root and the full asset list in all assets with the remaining assets for which PL has not yet been computed, continuing to populate in by descending fiat value. Switching between today's gain and loss and all-time gain and loss mid-populate should have no effect on the on the order in which asset PnL is populated in and displayed in asset list.

Populate should be able to handle the app being killed mid-populate and should be able to resume on the next app launch seamlessly with the asset list immediately showing computed PnL for assets for which have already been populated in and continuing to populate in the rest as if no interruption occurred.

The first ever populate and any subsequent incremental populate triggered on app launch must only begin after the user has passed the pin screen or biometric screen. Subsequent incremental populates must also begin after the user has passed the pin or biometric screen. And during an incremental populate, it is preferred but not required (if it would be simpler not to) to continue showing the old stale chart data and PnL numbers until the populate completes at which point those charts and PnL values in the asset list would update. 

Wallet specific populates must be triggered after a send from that wallet has been made. And all balance charts and asset list items throughout the app need to update to account for that send after that populate completes.

Pulling to refresh in a wallet, account, key overview, or home route that reveals that funds have been received to trigger another populate for the affected wallets and then immediately update all asset list items and charts that are affected throughout the app.

Pulling to refresh in any of those screens with a resulting rate change should also update charts and asset PnL throughout the app in affected groupings of the refreshed assets

Populates should not block PnL and chart reads. PnL and chart reads should not block each other.

Timeframe switches need to be nearly instant even when aggregating lots of wallets and a lot of snapshots.

Switching timeframes or scrubbing the chart should never result in flashes or flickers from react re-renders or maximum update depth exceeded errors.

The V4 fiat rates endpoint can return all seven intervals, but only four need to truly be fetched and stored. One day, one week, one month, and all time. That's because the three month, one year, and five year intervals are just subsets of the all-time interval. All three of those intervals are simply just daily rates on the same exact hour so they all overlap with the all time interval.

Simply switching timeframes after a while with the app open should not trigger a rate update behind the scenes or even a snapshot update. Only explicitly pulling to refresh on screens like home root, key overview, account details, and wallet details should cause rate updates and snapshot updates.

Turning the "Show Portfolio" toggle off in settings should clear the portfolio store (and hide all balance charts and asset lists) and turning it back on should repopulate from scratch and re-reveal balance charts and asset lists. If a user toggles the setting off and back on over and over again in quick succession that should be handled well. The Exchange Rates section in home root (and the Exchange Rate details screen with exchange rate charts) should continue to show whether "Show Portfolio" is disabled or not.

When new keys are imported and show portfolio is enabled in settings, that import should trigger a populate for all livenet wallets in that key. When keys are deleted, their associated portfolio snapshots should also be deleted. And all balance charts and asset list items should immediately update to no longer include them. When keys are hidden, the home route balance chart and the asset list should update to no longer include the hidden keys wallets in the displayed numbers. When wallets are hidden, key overview, account details, and home route balance charts and asset lists should also be updated to no longer include them. When they are unhidden, the associated balance charts and asset lists should update to reinclude them.

Populate should only ever happen for livenet/mainnet wallets (never testnet wallets)

Use Specify PnL calculation formula so it isn't assumed to be what it isn't

When scrubbing the PnL chart, the big balance above the chart and the PnL row underneath should update to match the values at each point and also include the timestamp of each point. When scrubbing the 1D, 1W, and 1M charts, the timestamp shown in the PnL row under the balance at the top should be formatted to include the date and hours "March 29, 2026 at 5:22 PM", when scrubbing the 3M, 1Y, 5Y charts the timestamp should omit hours: "March 29, 2026". The ALL time interval should format the timestamp in a way that matches the previous requirements based on how long the ALL time interval is (if less than 3M, include the hours too, if greater omit)

The PnL change when scrubbing the very first point on each balance chart should be exactly 0. The fiat balance and the PnL change on the final point when scrubbing the balance chart should exactly match the big number and pnl subtext at the top of each balance chart in the no scrubbing state (idle).

Handle corrupted txhistory for some wallets 

Specify v4 rate fetch url construction (especially for token rates)

Hide balances should hide all balance charts and mask all crypto and fiat balances and fiat pnl in asset list (pnl percentages can continue to show) - match current behavior

Balance charts should have 89 points

For the purpose of pnl calculations, any inflow is treated as a "buy" and any outflow is treated as a "sell" (there is no need to track movements between user owned wallets)

