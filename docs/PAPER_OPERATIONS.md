# Local paper controls

These commands run an offline fixture or a bounded read-only public-data session on the connected Mac. All fills are simulated; model is always `mock`, paid inference is $0, and there is no wallet or order-submission path. The worker ignores `.env`, receives a minimal environment, and exposes no HTTP listener. It never uses the existing Railway dashboard.

```sh
bun run paper:start --source public --seconds 900
bun run paper:status --source public
bun run paper:stop --source public
```

Bun 1.4.2 is the tested runtime. Public mode uses the documented Goldsky endpoint `https://rpc2.monad.xyz`, chain 143 and Kuru MON-USDC market `0x065C9d28E428A0db40191a54d33d5b7c71a9C394`. It calls only chain/head/header, book/vault/market-parameter reads, and trade-log reads. No credentials or subscriptions are needed. There are at most 25 RPC methods/second and a finite request budget. The default runtime is 900 seconds; the maximum accepted manual run is 3,600 seconds. RPC requests time out after five seconds. There are no retries, schedules, or automatic restarts.

`start` launches one detached worker and returns its identity and status. `status` verifies the PID, absolute worker path, and unique run ID with the host process table. `stop` verifies that same identity before signaling; it never kills an unrelated reused PID. A lock prevents duplicate workers for one account. Process-table access must be allowed; a permission failure is not evidence that a worker is stopped.

To test without network:

```sh
bun run paper:start --source fixture --seconds 30
bun run paper:status --source fixture
bun run paper:stop --source fixture
```

The bundled fixture has 24 authentic blocks, fewer than the 100-frame entry warmup, and completes in about seven seconds with no entries. Tests use longer synthetic fixtures to exercise lifecycle and strategy behavior. Fixture and public accounts are separate and source-checked.

## State and interpretation

Each account is stored under gitignored `data/paper-public` or `data/paper-fixture`, with private file permissions:

- `account.json`: atomically replaced, checksummed ledger, risk settings, last frame, cash, MON, costs, daily loss and latched halt. Ledger arithmetic and configuration are checked on restore.
- `frames.jsonl`: block-pinned snapshots, ordered prints, mock decisions, eligibility, simulated orders/fills and totals. The checkpoint is saved before appending; a crash between the two can leave the last checkpointed frame absent from this journal. Do not silently concatenate recordings across any resulting gap.
- `status.json`: last observed phase, process identity, market timestamp, block, request count, expiry and totals.
- `worker.log`: bounded-run lifecycle/error output; no keys or provider response bodies.

Status includes `running`/`processVerified`, `phase`, `marketDataAgeSeconds`, `observationAgeSeconds`, `lastBlock`, `haltReason`, `error`, and `latest`. `running: true` means an owned process exists, not that it has traded or is current. `starting`, `running`, `completed`, `time_limit`, `stopped`, `halted`, and `error` are distinct phases. Market timestamps have second resolution; several increasing blocks legitimately share a timestamp.

A new account starts with $100 and no MON. A restart preserves balances and daily/overall loss controls; it warms features again for 100 observed frames before new quotes. A restart after missing observations can immediately halt under the existing gap policy. A latched halt is preserved. Diagnose it rather than deleting files to reset losses. The system rejects corrupt, mismatched, or missing checkpoints when a journal remains.

Manual stop/time limit cancels local resting orders and preserves simulated inventory at its last observed mark. It does not invent a sale at an unobserved price. On resumed observations, gap/session controls can exit at the first actual observed bid, with the existing fee/slippage/gas assumptions. A sleeping/disconnected Mac cannot observe a stop or midnight boundary; this is disclosed by gaps/overnight counts. These controls are not loss guarantees.

## Freshness and remaining limits

Snapshots and logs are pinned to one completed block and checked against its hash. Adjacent frame parent hashes must match. Fees and sizing/precision parameters are checked against the fixed simulation assumptions. Historical gas assumptions are still estimates, not calibrated transaction costs. A reorg after acceptance is not retrospectively undone; a detected continuity change stops the account.

The runner catches up at most 20 blocks, fetching up to two consecutive complete frames in a ten-method RPC batch. It processes every frame sequentially and reuses the post-read head confirmation on the next iteration. Larger gaps halt. Each decision is allowed to quote only if the completed snapshot still matches the latest head and reading it took less than 300 ms. Slow public RPC may yield no eligible quotes or a safe halt. It is appropriate to record that limitation rather than weaken freshness to manufacture paper activity.

The strategy and ledger are shared with the offline harness, but public observation includes measured freshness gating. One-block order lifetime and a maximum 25% participation on strict trade-through remain approximations. No queue simulation, slippage calibration, Jev advantage, or profitability is established. Captured recordings need materially longer independent sessions and untouched forward evaluation before research conclusions.

Phone requests such as “paper status” or “stop paper trading” can be executed through the connected, awake Mac task. The process runs on that Mac. This change adds no phone app, public URL, remote tunnel, dashboard authentication, or cloud deployment. Jev access is separate future work: agree a request/spend cap and secure local secret injection first; never paste a key into chat or source control.

## Observed public launch

The authorized 900-second maximum public run on 2026-10-03 stopped early after 11.486 seconds. It captured 26 frames and made 183 read-only RPC method calls. Collection fell behind: the final observation jumped from block 110236083 to 110236109 (eight seconds), beyond the 20-block catch-up bound. The engine correctly latched its data-gap halt and the process exited. No frame was entry-eligible, warmup did not complete, and no quote or fill occurred. Cash remained $100, MON and P&L were zero, and paid inference was $0. See [the recorded result](paper-public-smoke.json).

The account and local journal were preserved, not reset or automatically restarted. This launch validates safe failure and public ingestion, not sustained trading. This exposed redundant round trips in capture. The follow-up batches two complete consecutive frames per request and removes the redundant head query, preserving all freshness, cost and loss limits. A later bounded run needs an explicit decision about the preserved halted account.

A single follow-up diagnostic used the tested two-block batching fix in a separate account, preserving the original ledger. It recorded 98 consecutive blocks (110236937–110237034) with no missing frame before the provider returned HTTP 429 after 31.532 seconds and 578 attempted read methods. It halted immediately without retry. Two of the 98 frames met the freshness check, both before the 100-frame warmup completed; there were no entries, quotes, fills, inventory, or paid inference. See [the batching diagnostic receipt](paper-public-batch-smoke.json).

The free endpoint's observed limits and latency do not support a claim of sustained operation. Before another run, establish a supported read budget and a capture design that can maintain complete block/trade windows within it. A lower-frequency strategy would need an explicitly revised observation/fill model and offline validation; simply dropping blocks or widening freshness to get fills would be misleading. Paid access, provider switching to evade a limit, or repeated retries are not part of this work. Both diagnostic workers are stopped and their halted accounts remain intact.

## Verification

The final offline suite passes 50 tests with 701 assertions, including authentic timestamp/order validation, complete two-block batches, deterministic prefix invariance, ledger persistence/corruption rejection, and owned-process start/status/stop. TypeScript, offline ABI encoding and `git diff --check` pass. The original synthetic report is byte-identical. Tests make no external HTTP calls; the two explicitly authorized operations diagnostics above are separate from the offline suite.
