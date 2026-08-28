# Trump Crumb Harvester

A small web app that simulates a fixed-capital profit-harvesting strategy for Official Trump (TRUMP).

## Core strategy

- Keep a fixed base capital invested in TRUMP.
- When TRUMP rises by the configured target (default +2%) from the current cycle entry price, harvest the gain.
- Bank the net profit separately.
- Immediately restart the next cycle using the same fixed base capital at the new market price.
- If TRUMP falls, do nothing and wait until the current cycle reaches its target.
- Repeat.

## Current build

- Responsive dashboard.
- Manual TRUMP price testing.
- Optional public CoinGecko price feed.
- Configurable base capital, target percentage and estimated fees.
- Automatic simulated harvest and immediate re-entry.
- Banked-profit ledger.
- Persistent browser state via localStorage.
- CSV export of completed harvest cycles.

## Kraken integration plan

The project is deliberately split so the strategy can later use the Kraken API without exposing credentials in the browser or in GitHub.

The future live-trading layer should:

1. Run on a private server/backend.
2. Read `KRAKEN_API_KEY` and `KRAKEN_API_SECRET` from encrypted environment variables/secrets.
3. Fetch balances and the TRUMP market price from Kraken.
4. Place/cancel orders through a dedicated Kraken adapter.
5. Keep the harvesting strategy independent from the exchange implementation.
6. Include a paper/live switch, order confirmation logging, fee/slippage accounting and safety limits before any live order is enabled.

**Never commit Kraken API keys or secrets to this repository.**

## Important

The current version is a simulator. It does not place live exchange orders. Crypto assets are volatile; fees, slippage and taxes can materially affect results.
