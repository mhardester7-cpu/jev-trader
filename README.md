# jev-trader: paper-only day trading

MON-USDC on Kuru/Monad, with a TypeSafe AI Jev adapter and an offline mock heuristic. This branch disables real wallets, signing, deposits, approvals, and order submission. `PRIVATE_KEY` is ignored; `DRY_RUN=false` fails at startup. No environment setting enables live trading.

The original repository was a demo, not a validated profitable strategy. See [the audit and research limits](docs/PAPER_AUDIT.md). No historical dataset or Jev evaluation has been supplied. Synthetic checks are software tests, not evidence of investment performance.

## Offline quick start

Use Bun 1.4.2 and the committed lockfile. Installation downloads dependencies; the commands after it need no network or credentials.

```sh
bun install --frozen-lockfile --ignore-scripts
bun test
bun run typecheck
bun run paper:demo
```

`paper:demo` prints the unchanged mock heuristic's results on a fixed synthetic fixture. Base and higher-cost assumptions are included. The [committed report](docs/paper-evaluation.synthetic.json) is reproducible.

Replay a locally supplied recording:

```sh
bun run paper:replay path/to/session-frames.jsonl 150 150
```

Each JSONL row must contain `{ "timestampMs": 1790856000000, "book": Book, "prints": TradePrint[] }` (types in `src/paper.ts`, `src/market.ts`, and `src/trades.ts`). Include every block, even without prints. Timestamps are UTC epoch milliseconds and must increase. Prints must belong to that row's block and be in chain order. Use raw data from a single session and market, not dashboard summaries. The harness rejects duplicate blocks, future prints, invalid prices, and crossed books. Missing blocks reject evaluation; a time gap over one second halts the simulator. It re-evaluates the **mock**, ignoring recorded model decisions and wall-clock latency; it does not backtest Jev.

The first 150 blocks warm features. Subsequent disjoint 150-block windows start with fresh cash, use only prior/current completed data, and score a frozen strategy with no parameter search. Reports contain the input hash, settings, fills, turnover, costs, equity P&L, liquidation P&L, drawdown, and cash/buy-and-hold benchmarks. These short defaults exercise the harness; use substantially longer independent market recordings for research. Each fold is an independent experiment, not a compounded equity curve.

## Intraday controls

MON-USDC is a crypto pair; UTC calendar days define the paper sessions, rather than equity exchange hours. Defaults are explicit research choices, not optimized settings:

| Control | Default |
| --- | --- |
| Initial cash / MON | $100 / 0 MON |
| Requested order size / minimum passive order | Up to 200 MON / 200 MON |
| Inventory cap | Lower of 1,000 MON and 25% of marked equity |
| Entry risk budget | 0.5% of equity divided by 1% stop distance |
| Stop / take-profit triggers | 1% below / 2% above average entry, observed at bid |
| Daily loss limit | 2% of UTC session starting liquidation equity |
| Overall drawdown halt | 5% from peak liquidation equity |
| Session close | Flatten at the first observed snapshot at/after 23:59 UTC; no new entries until the next UTC day |

Entry size is limited by cash including fees and gas, inventory allocation, and stop risk. If sizing falls below the passive minimum, skip the order. An unavailable model side is skipped, not reversed. Stop sizing is approximate: jumps and costs can exceed the chosen risk budget.

Stops, take-profit, daily-loss, and session-close exits are **local simulated market exits** at the next observed bid less assumed slippage, plus fee and gas. They can close residual inventory below the passive order minimum. A stop trigger is not a guaranteed price. Daily loss pauses entries until the next UTC session; the overall drawdown halt remains latched. An outage cancels local orders and halts; at the next valid snapshot it closes observed inventory. If the outage crosses midnight, `overnightBreaches` discloses the carry. The system never invents a fill at an unobserved midnight price.

## Fill and cost assumptions

- Process the completed block and its prints before deciding. An order from block N is eligible only in N+1, then expires locally. Same-block fills are impossible.
- A print must strictly trade through the limit on the opposite aggressor side. A touch does not prove queue priority. Eligible fill volume is capped at `PAPER_PARTICIPATION` (default 25%) and remaining order size. Maker execution stays at the limit.
- Charge estimated gas on every placed quote, including unfilled quotes; accumulate historical USD costs. Charge maker fees and actual model token costs. The mock has zero token cost.
- Mark equity at mid; separately estimate liquidation at bid minus exit fee, slippage, and one gas charge. Drawdown uses this liquidation estimate. A halt cannot guarantee a maximum loss during jumps/outages.
- An incomplete trade poll, invalid input, or model error halts the session. Stale model responses produce no order. Restarts begin a new paper ledger, so they also reset session loss accounting.

Fees, participation and slippage are estimates, not verified current market parameters. Local one-block expiry is not an on-chain Kuru TTL. Queue competition, reorgs, execution latency, failed transactions, standalone cancellation costs, and market impact need richer data/modeling before economic claims. Forced exits assume sufficient bid liquidity and may be optimistic in stressed markets.

## Optional read-only market feed

`bun run start` starts the existing API/dashboard backend with public RPC reads and paper orders. It is **not offline** and was not run during this audit. Keep `MODEL=mock`; do not supply wallet credentials. `MODEL=jev` makes billable inference requests and requires separately authorized provider access. No API key is needed for the offline workflow.

Recordings go to `data/<session UUID>-frames.jsonl` and `data/<session UUID>-events.jsonl`, which are gitignored. Live-feed timestamps are observation times, not authenticated block timestamps. Session separation prevents accidental concatenation on restart. No API keys are recorded. REST/SSE routes remain `/`, `/history`, and `/events`; `totals` now includes fees, cash, liquidation P&L, drawdown, daily loss pause, and overnight breaches. `fills` preserves all fills, including mixed-side stop exits. The legacy `fill` is null for mixed-side blocks. The existing dashboard uses the original compatible fields; inspect the API/report for detailed controls and halt status.

The Jev adapter uses `TYPESAFE_AI_API_KEY` (AI SDK naming) and defaults to pinned `jev-1.13.0`. TypeSafe's standalone SDK examples use `TYPESAFE_API_KEY`; these are different variable names. Before a future authorized Jev test, inject the key through a local secret manager/process environment, never chat or git, and establish a request/spend budget. No scoped or free paper endpoint was verified in the reviewed TypeSafe documentation. Jev evaluates decisions; it is not the exchange.

## Code map

| File | Responsibility |
| --- | --- |
| `src/paper.ts` | Deterministic fills, spot ledger, costs, UTC sessions and risk controls; no I/O |
| `src/replay.ts` | Frozen mock strategy, chronological evaluation and benchmarks |
| `src/state.ts` | Shared causal market features |
| `src/trader.ts` | Sequential paper loop, freshness gates, session recordings |
| `src/model.ts` | Jev adapter and unchanged mock signal |
| `src/market.ts`, `src/book.ts` | Block-pinned reads and tick-aligned quotes; wallet is always null |
| `tests/` | Offline regression tests; unexpected fetch calls fail |

Legacy transaction encoding/receipt code remains in `Market` for reference but is unreachable with its fixed null wallet. Historical `SPEC.md` and earlier demo marketing do not authorize real trading. No deployment, scheduled run, or merge is included in this work.
