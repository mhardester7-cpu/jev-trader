# jev-trader: paper-only day trading

MON-USDC on Kuru/Monad, with a TypeSafe AI Jev adapter and an offline mock heuristic. This branch disables real wallets, signing, deposits, approvals, and order submission. `PRIVATE_KEY` is ignored; `DRY_RUN=false` fails at startup. No environment setting enables live trading.

The original repository was a demo, not a validated profitable strategy. See [the audit and research limits](docs/PAPER_AUDIT.md). The selected free workflow replays a saved authentic historical sample with the original fast mock policy. No Jev evaluation has been performed. Short historical replays and synthetic checks do not establish investment performance.

## Offline quick start

Use Bun 1.4.2 and the committed lockfile. Installation downloads dependencies; the commands after it need no network or credentials.

```sh
bun install --frozen-lockfile --ignore-scripts
bun test
bun run typecheck
bun run paper:free-replay
bun run paper:demo
```

`paper:free-replay` verifies the bundled raw RPC cache and recording hashes, then prints base/stress results with cash and buy-and-hold comparisons. It needs no account, key, network or inference spend. See [the free replay guide](docs/FREE_REPLAY.md), [recording](research/mon-usdc-20260917) and [committed historical report](docs/paper-evaluation.recorded.json). It does not run a live bot or test Jev. The original policy is unchanged.

`paper:demo` prints the unchanged mock heuristic's results on a fixed synthetic fixture. Base and higher-cost assumptions are included. The [committed synthetic report](docs/paper-evaluation.synthetic.json) is reproducible.

Replay a locally supplied recording:

```sh
bun run paper:replay path/to/session-frames.jsonl 150 150
```

Each JSONL row must contain `{ "timestampMs": 1790856000000, "book": Book, "prints": TradePrint[] }` (types in `src/paper.ts`, `src/market.ts`, and `src/trades.ts`). Include every block, even without prints. Timestamps are UTC epoch milliseconds and must never decrease. Equal timestamps are valid because EVM block timestamps have one-second resolution; block numbers must still increase consecutively. Prints must belong to that row's block and be in chain order. Use raw data from a single session and market, not dashboard summaries. The harness rejects duplicate blocks, future prints, invalid prices, and crossed books. Missing blocks reject evaluation; a time gap over one second halts the simulator. It re-evaluates the **mock**, ignoring recorded model decisions and wall-clock latency; it does not backtest Jev.

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
- An incomplete trade poll, invalid input, or model error halts the session. Stale model responses produce no order. The managed local runner below persists its ledger and loss accounting across restarts. The legacy API loop starts a separate ledger each time.

Fees, participation and slippage are estimates, not verified current market parameters. Local one-block expiry is not an on-chain Kuru TTL. Queue competition, reorgs, execution latency, failed transactions, standalone cancellation costs, and market impact need richer data/modeling before economic claims. Forced exits assume sufficient bid liquidity and may be optimistic in stressed markets.

## Original fast-mode setup

The current choice is [free recorded replay](docs/FREE_REPLAY.md), which preserves the original per-block strategy. The paused slower prototype is not in this branch. [The fast setup guide](docs/FAST_SETUP.md) documents future provider capacity, latency and Jev requirements if live data is requested later; those are not prerequisites for offline replay. `bun run paper:doctor` is an offline readiness check.

## Bounded local paper run

Use the [local operating guide](docs/PAPER_OPERATIONS.md) for start, status, stop, recovery, and limits. This optional live-feed mode is separate from the selected offline workflow. Earlier public runs halted on gaps/throttling; their accounts remain halted. Do not repeatedly restart them. The managed runner has no web server and never calls Jev.

```sh
bun run paper:start --source public --seconds 900
bun run paper:status --source public
bun run paper:stop --source public
```

This explicitly starts up to 15 minutes of public Monad reads with the unchanged mock strategy. It simulates all orders locally, persists cash/inventory/risk state, and defaults to a $100 paper account. It requires this Mac to stay awake and connected; the phone can request these controls through its connected task, but does not run the bot. A reported process identity alone is not a healthy feed: inspect phase, market-data age, latest block, and any error.

## Legacy read-only market feed

`bun run start` is the separate legacy API/dashboard backend, not the managed runner. It starts with public RPC reads and paper orders. It is **not offline** and was not run during this audit. Keep `MODEL=mock`; do not supply wallet credentials. `MODEL=jev` makes billable inference requests and requires separately authorized provider access. No API key is needed for the offline workflow.

Recordings go to `data/<session UUID>-frames.jsonl` and `data/<session UUID>-events.jsonl`, which are gitignored. Live-feed timestamps are observation times, not authenticated block timestamps. Session separation prevents accidental concatenation on restart. No API keys are recorded. REST/SSE routes remain `/`, `/history`, and `/events`; `totals` now includes fees, cash, liquidation P&L, drawdown, daily loss pause, and overnight breaches. `fills` preserves all fills, including mixed-side stop exits. The legacy `fill` is null for mixed-side blocks. The existing dashboard uses the original compatible fields; inspect the API/report for detailed controls and halt status.

The Jev adapter uses `TYPESAFE_AI_API_KEY` (AI SDK naming) and defaults to pinned `jev-1.13.0`. TypeSafe's standalone SDK examples use `TYPESAFE_API_KEY`; these are different variable names. Before a future authorized Jev test, inject the key through a local secret manager/process environment, never chat or git, and establish a request/spend budget. No scoped or free paper endpoint was verified in the reviewed TypeSafe documentation. Jev evaluates decisions; it is not the exchange.

## Code map

| File | Responsibility |
| --- | --- |
| `src/paper.ts` | Deterministic fills, spot ledger, costs, UTC sessions and risk controls; no I/O |
| `src/replay.ts` | Frozen mock strategy, chronological evaluation and benchmarks |
| `src/historical.ts`, `scripts/paper-collect.ts` | Bounded historical public reads, cache integrity and complete-window decoding |
| `src/recording-report.ts`, `scripts/paper-free-replay.ts` | Verified offline historical report and fixed cost stress case |
| `src/state.ts` | Shared causal market features |
| `src/trader.ts` | Sequential paper loop, freshness gates, session recordings |
| `src/model.ts` | Jev adapter and unchanged mock signal |
| `src/market.ts`, `src/book.ts` | Block-pinned reads and tick-aligned quotes; wallet is always null |
| `tests/` | Offline regression tests; unexpected fetch calls fail |

The web app still defaults to the pre-existing Railway API URL; it is not connected to the managed local account. No local dashboard has been exposed or deployed.

Legacy transaction encoding/receipt code remains in `Market` for reference but is unreachable with its fixed null wallet. Historical `SPEC.md` and earlier demo marketing do not authorize real trading. The initial safety changes were merged in PR #1 after approval. These local operating changes require separate review; they add no deployment or schedule.
