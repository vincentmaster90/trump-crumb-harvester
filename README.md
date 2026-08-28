# Trump Crumb Harvester

TRUMP profit-harvesting simulator.

## Core strategy

- Keep a fixed base capital invested in TRUMP.
- When TRUMP rises 2% from the current cycle entry price, realize the gain.
- Bank the profit separately.
- Immediately restart with the same fixed base capital at the new market price.
- If TRUMP falls, hold and wait for the +2% target from the current cycle entry.
- Repeat.

The first version is a simulator/backtester only. No live exchange orders are placed.
