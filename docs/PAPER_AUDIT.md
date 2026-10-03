# Paper day-trading audit

Audit date: 2026-10-03. Baseline: `b587759e459ea049590102e54a0b07800864cdc3` on `mhardester7-cpu/jev-trader` main. Work was isolated in a fresh clone and `codex/paper-execution-audit`; no other checkouts were modified.

## Follow-up status

PR #1 was subsequently merged after explicit user approval. A separate follow-up adds provenance-recorded ingestion fixtures, equal-second timestamp support, and durable bounded local controls. See [the operating guide](PAPER_OPERATIONS.md) and [source validation](PAPER_DATA_SOURCE.md). The original audit results below describe the initial audit, before these later reads and controls. No Jev evaluation or evidence of profitable trading has been added.

## Outcome

The repository now has a testable paper intraday execution/accounting foundation. Real trading is disabled. The existing mock signal was preserved, not tuned for a more attractive backtest. There is **no evidence yet that Jev or the mock can trade this market profitably**. No authentic historical dataset, Jev responses, live paper feed run, or paid inference was used.

The user clarified day-trading intent during the audit. The actual instrument is MON-USDC crypto on Kuru/Monad, not equities or futures. UTC days define research sessions: flatten in the final minute, skip entries until the next day, apply stop/take-profit exits, size to cash/equity/stop risk, and pause after the daily loss limit. These are configurable defaults selected for testing, not optimized trading recommendations.

## Baseline findings

| Finding | Evidence at baseline | Change |
| --- | --- | --- |
| A present wallet key enabled real execution and startup funding | `config.dryRun` depended on missing `PRIVATE_KEY`; `Market.init` called `ensureMargin`, including token approval/deposit | Never read a wallet key; fixed null wallet; reject non-paper configuration |
| Paper fills depended on race timing | Trade logs polled asynchronously while each decision cleared/replaced simulated orders | Sequential block-pinned book + complete logs; shared deterministic execution engine |
| Paper funds were fictional | Signed inventory allowed shorting without MON; bankroll only scaled reported percentage | USDC cash + owned MON, cash reserve for fees/gas, allocation and inventory caps |
| P&L understated costs | Sim quotes charged zero gas; inference excluded from net P&L; all historical gas revalued at current mid | Charge estimated quote/exit gas, fees and reported inference usage; historical USD costs; separate liquidation estimate |
| Late responses could still place orders | Busy blocks were labeled late, but the older model response still sent | Discard when a newer block is seen or the loop exceeds 300 ms; Jev request timeout |
| Model prompt contradicted execution | Prompt still described immediate-or-cancel market orders after post-only conversion | Describe resting post-only orders and uncertain fills; remove unsupported claim that taker flow is strongest |
| No intraday exits or daily controls | Only a gross MON cap | UTC close, stops/take-profit, daily loss pause, equity/stop sizing, latched drawdown halt |
| No reproducible performance evidence | No tests or market recordings; append-only summaries omitted raw depth/prints and delayed updates | Offline tests, session-specific raw frames, input hashes, fixed-policy forward-window evaluation |

Legacy live receipt/order reconciliation also has unresolved race/recovery risks (fills preceding receipts, treating missing receipts as gone, no restart reconciliation). That path is disabled and was not expanded or validated for real execution.

## Verified provider and official sources

- [TypeSafe API reference](https://docs.typesafe.ai/api): Jev evaluates state/questions at `POST https://api.typesafe.ai/v1/systemone`, using bearer authentication. It is an inference service, not the exchange. Installed `@ai-sdk/typesafe-ai@3.0.0` source confirms this base URL and the `TYPESAFE_AI_API_KEY` environment name.
- [TypeSafe models](https://docs.typesafe.ai/models): the reviewed `jev-latest` alias resolved to `jev-1.13.0`; aliases can move. The adapter now defaults to the versioned identifier. The page documents $0.042 per million input tokens; output tokens are free. This remains an estimate in code, not account billing reconciliation.
- [TypeSafe's model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13): the provider advises keeping mathematical calculations and date comparisons in code. It reports numeric precision and instruction-consistency weaknesses. This supports deterministic risk/accounting checks, not a claim about return predictability.
- [Kuru OrderBook](https://docs.kuru.io/contracts/OrderBook) and [MarginAccount](https://docs.kuru.io/contracts/MarginAccount): orders trade on the on-chain book using deposited asset balances; debiting insufficient funds reverts. A paper short without owned MON does not mirror this funding mechanism.
- [Monad gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing): gas is charged against the gas limit; base plus priority determines unit price. The documented minimum base fee is 100 gwei. The repo's assumed 350,000 gas at 102 gwei yields 0.0357 MON per quote, but actual transaction cost must be measured for a future execution study.
- [Kuru liquidity risks](https://docs.kuru.io/liquidity/risks-impermanent-loss): liquidity provision can accumulate the falling asset, and earnings may fail to cover inventory losses. Resting inside a spread does not imply a positive expected return.

No provider account or credential endpoint was called. The reviewed documentation did not establish scoped, nonbillable evaluation credentials. For a later separately approved Jev experiment, use a dedicated provider credential with only evaluation access if available, verify actual scopes in the console, disable automatic credit refills, and agree a request/spend cap first. Inject through a secret manager or ephemeral process environment; never chat, source control, or logs. No blockchain wallet key is needed.

## Evaluation method and result

The committed [synthetic report](paper-evaluation.synthetic.json) is generated by `bun run paper:demo`. It uses seed `123456789`, 600 constructed 300 ms frames, a fixed 100-block signal horizon, 150 warmup frames, and three disjoint 150-frame scoring windows. Each window starts at $100 cash. No thresholds are fit or selected; this is a chronological harness smoke test, not empirical out-of-sample evidence. Each scoring window spans only about 45 seconds.

Input hash: `900e9325733e9a28ff9eccfdf1f02b6449966d8189f82f6bf6e6c9c186622fea` (SHA-256 over normalized frames).

| Blocks | Maker fills | Quotes | Base net liquidation P&L | Higher-cost P&L | Base buy-and-hold P&L | Cash P&L |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 151–300 | 27 | 88 | -$0.058112 | -$0.200885 | -$0.075695 | $0 |
| 301–450 | 6 | 24 | -$0.022683 | -$0.056932 | -$0.163579 | $0 |
| 451–600 | 29 | 81 | -$0.044485 | -$0.190926 | -$0.057488 | $0 |

Base assumptions: 2 bps maker fee, 5 bps exit fee, 5 bps exit slippage, 0.0357 MON quote/exit gas, and 25% participation on strict trade-through. Stress case: 10/10/10 bps and 0.0714 MON gas. No fee or rebate schedule was queried on-chain. Both benchmark and strategy receive the same initial capital, maximum inventory/allocation limits and exit cost assumptions; buy-and-hold crosses ask on entry, bid on exit, charges entry/exit costs, and holds remaining cash. It is a static comparison, not an intraday strategy with stops.

All six modeled windows lose to cash. Some beat falling-market buy-and-hold in this constructed fixture. Neither observation demonstrates a real-world edge. Win rate/annualized Sharpe/significance claims would be misleading with these tiny, dependent, synthetic samples and partial fills; none are reported. The code's no-lookahead check changes future prices and verifies that earlier orders and equity remain identical.

Cost sensitivity matters before signal optimization. At the assumed 300 ms cadence, one 0.0357 MON quote every block would cost 428.4 MON per hour (about $8.568 at an illustrative $0.02/MON), even if no quote fills. This is arithmetic under declared assumptions, not a current price quote or observed burn rate. Actual strategy quote count is lower because of risk/funding/latency gates.

## Verification

Baseline locked install and TypeScript check passed; `bun test` found no tests. Added offline tests cover:

- Next-block-only fills, no touch fills, partial volume conservation, order expiry and gaps.
- Known round-trip reconciliation, gas cost history, inference cost subtraction, cash/inventory caps and invalid inputs.
- Stop fill at observed price, take-profit cost, UTC close/no new entries, daily reset, equity/stop sizing and disclosed overnight outages.
- Config rejection with a dummy wallet-key variable, fixed null wallet, incomplete polls, late inference, hold behavior and no forced side reversal.
- Repeatability, disjoint forward windows, prefix invariance, cost/accounting invariants and a no-print market losing to cash.

Final verification: 33 tests passed with 519 assertions; TypeScript passed; the repeated synthetic JSON report matched byte for byte; `git diff --check` passed. Run `bun test`, `bun run typecheck`, and `bun run scripts/dry-encode.ts`. The encoding script now uses offline ABI fixtures and no wallet, signing, or RPC. Tests install a fetch guard; unexpected HTTP requests fail. No test contacts TypeSafe, Kuru, Monad, a brokerage, or the deployed dashboard.

## Remaining limitations and next safe experiment

1. Obtain local recordings of full book snapshots and ordered trade prints across many complete UTC sessions, with provenance, timestamps, market parameters and resolved model version. No such data is present. A read-only recorder can be considered separately; no service access was started here.
2. Reconcile actual market minimums, fees, gas, queue priority and latency. Current maker eligibility is a conservative heuristic, not a queue simulator. One-block local expiry is not native Kuru behavior, and standalone cancellations are not separately costed. Stop/close fills assume sufficient bid liquidity and can understate impact.
3. Evaluate a frozen strategy over untouched forward sessions and multiple regimes with fees/spread/slippage and latency stress. Preserve cash and buy-and-hold benchmarks and add simple momentum/noise ablations before attributing performance to Jev. If labeled training/tuning is introduced, purge at least the forward label horizon at split boundaries; do not choose parameters on the test set.
4. Test Jev only after explicit budget and secure access setup. Preserve input states, responses, resolved version and usage; use predeclared thresholds and proper scoring/calibration on nonoverlapping forward outcomes. General confidence does not establish a calibrated probability of a future price increase.
5. The connected loop is intentionally strict: coalesced/missing blocks or a >1 second observed gap halt. Startup catch-up may miss its first deadline. Robust capture/backfill and block-hash/reorg handling are future work. No connected feed or front-end build/visual QA was run. The existing dashboard does not yet expose every new risk field; use the API/report.
6. Paper restart resets the ledger and daily loss accounting. Do not combine sessions as a continuous funded account or treat restarts as a way to evade daily limits. Persistent recovery is required before continuous paper operation. Missing observations cannot guarantee a flat midnight; breaches are counted and first-observed exits are reported.

No real orders, deposits, approvals, model API calls, brokerage setup, paid data, deployment, automation, or merge were performed. The deliverable is a reviewable paper-only research branch, not a production trading system.
