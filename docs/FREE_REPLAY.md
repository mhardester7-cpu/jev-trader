# Free replay of the original fast paper strategy

The selected workflow is local historical replay. It uses the unchanged per-block mock policy, authentic recorded MON-USDC books/trades, a $100 funded paper account, costs and the existing intraday risk controls. No RPC account, Jev key, wallet or subscription is needed. This is a reproducible software/research workflow; the included short sample cannot establish reliable profitability.

## Observed result

The bounded collection completed on 2026-10-03: **600 consecutive blocks and 262 Trade prints**, covering **2026-09-17 02:38:53 to 02:41:54 UTC** (181 seconds). It made 2,333 new read-only method calls and reused 75 cached results, finishing in 14 minutes 17 seconds without errors, retries or missing observations. All per-block market parameters were checked. Observed maker/taker fees were zero; the simulation retained its positive fee assumptions. Block base fees ranged from 100 to about 103.294 gwei.

After the predeclared warmup, the continuous paper account scored 450 blocks over 135 seconds:

| Metric | Base costs | Higher costs |
| --- | ---: | ---: |
| Net liquidation P&L on $100 | **-$0.187767** | **-$0.446777** |
| Net liquidation return | -0.187767% | -0.446777% |
| Cash benchmark P&L | $0 | $0 |
| Allocation-limited buy-and-hold P&L | -$0.043852 | -$0.090704 |
| Quotes / fill events | 261 / 13 | 261 / 13 |
| Charged quote gas | $0.210637 | $0.421274 |
| Charged maker fees | $0.011316 | $0.056580 |
| Gross realized trading P&L before costs | $0.037008 | $0.037008 |
| Ending MON, still held | 101.769649 | 101.769649 |
| Maximum observed liquidation drawdown | 0.187767% | 0.446777% |

The residual MON is valued at an estimated exit price and cost, not sold by an invented final fill. Thirteen fill events do not mean thirteen complete round trips. The account did not halt or hit a stop/daily limit; this small interval does not test adverse regimes. Simulated costs are not actual spending: the collection/replay made no paid call or trade and mock inference cost was zero.

The three separate 150-block windows, each starting with fresh $100, returned base net P&L of -$0.053217, -$0.079848 and -$0.046802. Higher-cost P&L was -$0.106434, -$0.218161 and -$0.093637. All lost relative to cash. Do not add these resets into the continuous account or extrapolate any result to a day/year. Quote gas exceeded the small gross trading gain in the continuous replay. **No profitable edge is established, and this one three-minute interval is too small for a reliable performance conclusion.**

The exact [machine-readable report](paper-evaluation.recorded.json) includes all settings, windows, balances and benchmarks. Dataset SHA-256: `1511f08670a9034e6c88c6fcc04c69971775f2242d2960c965029dedff046443`. Raw cache SHA-256: `f4135fa56075742f026fab2c6929060b1a342a4cc50f9680233513ca069ccd49`.

Verification: 67 offline tests / 812 assertions pass, along with TypeScript and diff checks. Coverage includes collection budgets/no-retry behavior, corrupted source rejection, missing-data handling, causal scoring and an end-to-end replay of this bundled recording with network disabled. The recorded report reproduces byte-for-byte; the original synthetic report remains unchanged.

## Run it

After installing the locked dependencies once:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run paper:free-replay
```

The replay command is entirely offline. It reads `research/mon-usdc-20260917`, checks the raw-cache and frame hashes, decodes every complete historical block again, checks chain continuity, and scores the fixed protocol. It writes nothing and does not load `.env`. To save a new report locally:

```sh
bun run paper:free-replay > /tmp/jev-recorded-report.json
```

Compare it with `docs/paper-evaluation.recorded.json`. Identical inputs and this code produce byte-identical JSON. A recording directory supplied as the optional argument must contain `manifest.json`, `frames.jsonl`, and `cache.json.gz` or `cache.json`; the command verifies all three agree. It rejects corruption or changed market parameters rather than replacing observations.

## Evaluation protocol

Before collecting/scoring the extension, the protocol was fixed at **150 warmup blocks followed by disjoint 150-block scoring windows**. Each window starts with $100 and zero MON; its feature history uses only earlier and current completed blocks. A separate continuous account starts after the same warmup and carries its inventory and loss limits through the remaining recording. Windows are not compounded, independent regimes, or model-fitting runs. The mock was not modified or optimized.

| Cost/control | Base | Higher-cost stress |
| --- | ---: | ---: |
| Maker fee | 2 bps | 10 bps |
| Exit fee / slippage | 5 / 5 bps | 10 / 10 bps |
| Gas per quote/exit | 0.0357 MON | 0.0714 MON |
| Maximum observed print participation | 25% | 25% |
| Starting cash / MON | $100 / 0 | $100 / 0 |

Gas is charged even when a quote never fills. Maker fills require strict trade-through in the next block; touches do not fill, and orders expire locally after that block. The report distinguishes mid-mark equity from estimated net liquidation at bid after exit costs. The final inventory is valued, not filled by inventing a terminal trade. Cash and allocation-limited buy-and-hold benchmarks include the same applicable entry/exit cost assumptions. See the README for position limits, stop/target, daily-loss and drawdown controls.

Historical fees are read from the contract at every block and disclosed separately; configured positive fees remain in the simulation. The gas estimate is not calibrated to actual bot quote/cancel receipts. Neither doubled gas nor the higher-cost case proves realistic worst-case execution. Standalone cancellation costs, competition, latency, failed transactions, market impact and forced-exit depth remain limitations.

## Recording and provenance

The extension was chosen as a continuation of the previously cached block range, before examining strategy results. It requested blocks **105488246–105488845** from the same free Goldsky endpoint, `https://rpc2.monad.xyz`, with a ceiling of 600 blocks, 2,500 methods and 15 minutes. It reused the earlier 24-block observations; missing per-block market parameters were fetched rather than filled forward. The manifest states the actual complete prefix, method count, timestamp range, stop reason and hashes.

The collector asks for block headers, block-pinned book/vault/market-parameter state, and Trade logs in complete ranges of at most 100 blocks. It uses one request at a time, batches of at most three methods, and at least 1.1 seconds between batches (about 2.73 methods/second). Any HTTP/RPC error, including 429, stops the invocation without a retry or endpoint rotation. The cache is saved after each completed batch. Missing data ends the contiguous prefix; it is never forward-filled or skipped. Logs must match the requested market/window and their block hash; book/header numbers, parent links, timestamps and market parameters are validated.

[Monad's network documentation](https://docs.monad.xyz/developer-essentials/network-information) lists Goldsky at 300 requests per 10 seconds and a ten-method batch maximum. Conservative pacing does not guarantee access. [Monad's historical-data documentation](https://docs.monad.xyz/developer-essentials/historical-data) distinguishes historical transactions from retained state; availability of this range does not imply unrestricted archive access. [Kuru's integration documentation](https://docs.kuru.io/contracts/Integration) describes the events used. A single provider's result and local checksums are reproducible evidence, not an independently authenticated proof that it omitted no events.

The raw compressed cache contains public chain data only. Its entry-level retrieval timestamps and checksums distinguish reused observations from the extension. `manifest.json` records the collection receipt and overall hashes. `frames.jsonl` contains decoded observations, including block hashes, actual second-resolution timestamps, observed fees and base fees. Repeated second timestamps are valid; unique consecutive block numbers determine order. The separate seven-second ingestion fixture remains in `tests/fixtures` for regression tests.

## Optional new historical collection

This command is **not offline** and is not required to run the included replay. Only run a new collection when a specific historical range has been selected and another bounded read is intended:

```sh
bun run paper:collect --start HISTORICAL_START_BLOCK --count 600 --dir data/a-new-recording
bun run paper:free-replay data/a-new-recording
```

Replace `HISTORICAL_START_BLOCK` with a concrete existing block number. Counts must be between 1 and 600. The fixed endpoint and read methods cannot submit an order or call a model. A failed collection preserves its cache; diagnose the cause before any separately chosen attempt. Do not automate repeated retries after throttling. Offline cache decoding is available with `--offline true`; invocation receipts are appended to `collection-history.jsonl`, while `manifest.json` describes the latest decode.

The old public live accounts remain halted. Historical replay assumes decisions can place in the next block; the failed public live-feed tests demonstrated that this assumption was not achieved on that feed. This command does not restart those accounts, test Jev or revive the paused slower prototype. A useful future research step is additional preselected recordings from distinct market regimes, followed by the same frozen protocol and better execution-cost calibration. No collection, live session, paid access or schedule runs automatically.
