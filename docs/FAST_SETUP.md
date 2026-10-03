# Original fast paper mode: setup and remaining gates

Checked 2026-10-03. The selected strategy is the original per-block MON-USDC market-making policy, with paper-only execution, funded spot accounting, fees/gas, causal fills, persistence and intraday risk controls. The paused five-second alternative is not in this branch and was never launched. Both earlier public-feed accounts remain halted and their workers are stopped.

**Current user choice: free recorded replay.** Run `bun run paper:free-replay` using [the free replay guide](FREE_REPLAY.md). It requires no provider account, key or Jev spend. The provider and integration discussion below is retained for a possible future live-feed request; no provider decision is needed for the selected offline workflow.

## What works now

The managed runner supports offline fixtures and the fixed public read-only source with `mock` decisions. Its start/status/stop commands, durable ledger, checksums, source identity, PID validation, finite runtime and request budget are tested. It has no HTTP listener or wallet. Starting an already halted account exits before any network request. The public source previously failed on rate/freshness limits; do not keep restarting it.

```sh
bun run paper:doctor --source public --seconds 900 --input-tokens 2000
bun run paper:status --source public
bun run paper:stop --source public
```

`paper:doctor` reads only the selected account and performs offline capacity arithmetic. It does not inspect credentials, change a ledger, contact a provider, or establish that a feed is healthy. `paper:status` verifies the worker identity and reports feed age. The doctor does not enable a private endpoint or Jev.

For a complete credential-free lifecycle check, use the fixture account:

```sh
bun run paper:start --source fixture --seconds 30
bun run paper:status --source fixture
bun run paper:stop --source fixture
```

The built-in authentic fixture is shorter than strategy warmup, so zero trades are expected. Longer deterministic fixtures exercise fills and risk controls in the test suite. A phone can ask the connected Mac task to run these commands while the Mac is awake; this is not a phone-hosted bot or a deployed dashboard.

## Feed capacity and latency

At one block per 300 ms, there are about 3.33 blocks/second. The current reader makes three `eth_call` requests plus a header and trade-log request per block, and one head confirmation per one/two-block batch. That is approximately **18.33–20 RPC methods/second**, before startup/idle polling, bounded by the local 25-method/second limiter. Request a plan with headroom; 50 methods/second is a practical capacity target, not a measured requirement or latency guarantee. Batch support must allow ten methods, and recent block-pinned state plus complete logs must work for chain 143 and this exact market.

Capacity alone is insufficient. The complete book/log read, head check, feature construction and any inference must fit below the existing 300 ms deadline, with a still-current block. The Jev adapter has a 250 ms timeout, which is not a latency promise and does not leave 250 ms after an already slow read. Two-block catch-up preserves recordings; it is not evidence that those historical decisions are current. Benchmark actual tail latency, valid current-block decisions, gaps, reorg handling and throttles from this Mac before calling the setup usable. Paying for a plan does not guarantee this.

[Monad's official network table](https://docs.monad.xyz/developer-essentials/network-information) lists public Goldsky at 300 requests/10 seconds and batch ten. That advertised capacity did not prevent an observed HTTP 429. The [RPC overview](https://docs.monad.xyz/reference/json-rpc/overview) explains speculative `latest`/WebSocket data and commitment states. A future supported WebSocket collector can reduce polling, but it still needs complete windows, reconnection/backfill and proposal/finality handling. It is not currently wired into the managed runner. [Kuru documents Trade-event indexing](https://docs.kuru.io/contracts/Integration); a guaranteed free low-latency venue book stream was not established.

## Provider choices to confirm, not purchases

| Choice | Published terms | Fit and unresolved point |
| --- | --- | --- |
| Existing authorized Monad account | User's actual plan and limits | Prefer this if it supports the method mix, budget and measured latency. No account/key was inspected. |
| QuickNode Build | $49 billed monthly; advertised $34/month requires annual billing. 50 rps, 80M credits. | Sufficient nominal request headroom; benchmark the actual read pipeline. No subscription created. |
| QuickNode free trial | One month, 10M credits, 15 rps, no card required | Below the current steady request demand. Not a ready solution for this unchanged collector. |
| Alchemy Free | 30M CU/month, 500 CU/s; headline 25 rps | The weighted method mix needs about 543–560 CU/s before headroom, exceeding the CU limit. Headline rps alone is misleading. |
| Alchemy Pay As You Go | $0.525 per million CU; 10,000 CU/s / headline 300 rps included | Nominal capacity is adequate. Estimated HTTP compute is $1.03–$1.06 per hour at continuous full cadence, excluding other traffic/subscriptions; benchmark and set an account cap. |

Sources: [QuickNode pricing](https://www.quicknode.com/pricing), [Monad HTTPS/WSS and recent archive support](https://www.quicknode.com/chains/monad), [QuickNode credit weights](https://www.quicknode.com/api-credits), [Alchemy pricing](https://www.alchemy.com/pricing), [Alchemy method weights](https://www.alchemy.com/docs/reference/compute-unit-costs), and [Alchemy supported networks](https://www.alchemy.com/docs/reference/node-supported-chains). Alchemy's network table lists Monad mainnet while its older Monad quickstart still says testnet-only; confirm actual account endpoint capabilities, not that older example.

QuickNode lists 30 credits per standard Monad method. This collector therefore uses roughly 1.98–2.16M credits/hour at steady cadence, or about 37–40 hours within 80M credits if no other usage. That is not an all-day monthly allowance. Alchemy's current weights are header 20, call 26, logs 60 and head 10 CU; batches sum the included methods. These are arithmetic scenarios, not observed bills. Pricing and account terms may change; no overage or recurring spend has been approved.

## Jev access and cost

[Jev's model page](https://docs.typesafe.ai/models) lists `jev-1.13.0` at $0.042 per million **input** tokens; output tokens are free. It says state is ingested once across questions and advertises 80 requests/second and 100K tokens/second, with limits subject to change. The [API reference](https://docs.typesafe.ai/api) uses bearer authentication and reports `usage.input_tokens`/`output_tokens`. No cache discount, minimum bill, scoped evaluation key or guaranteed sub-250 ms latency was verified.

At the upper scenario of one accepted decision every block (12,000/hour):

| Assumed input tokens per decision | Jev input cost/hour | 15-minute scenario |
| --- | ---: | ---: |
| 1,000 | $0.504 | $0.126 |
| 2,000 | $1.008 | $0.252 |
| 4,000 | $2.016 | $0.504 |

Actual tokens include the submitted state/questions as billed by the provider and have not been measured. These estimates are neither a hard spending cap nor profitability evidence. A cancelled request may still be billable. Before any call, the integration needs explicit per-run duration/request/dollar limits and conservative budget reservation for in-flight or unknown-usage requests. The managed runner remains mock-only until that guarded integration is completed and authorized; setting `MODEL=jev` on the legacy server is not a substitute.

## Minimum decisions and secure handoff

1. Choose an existing suitable Monad read endpoint, or authorize a specific provider plan and a maximum trial spend. No purchase, signup, billing change or provider call has been made.
2. Authorize a separate Jev per-run dollar/request cap if Jev is wanted. The mock requires no Jev key.
3. Select secure local handoff after these decisions: inject the dedicated RPC URL/token and `TYPESAFE_AI_API_KEY` through an ephemeral process environment or an explicitly approved secret-manager reference. Do not paste secrets into chat, command arguments, docs or Git. No persistent credential entry will be created without confirmation. The standalone TypeSafe SDK calls its variable `TYPESAFE_API_KEY`; this repository's installed AI SDK uses `TYPESAFE_AI_API_KEY`.
4. Use read-only RPC methods only (`eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_call`, `eth_getLogs`; subscriptions only if a tested adapter needs them). Select provider method/IP restrictions if available; do not assume such scopes exist. No wallet, signer, send-transaction, funds, administrative key or billing-management permission is needed. Jev needs evaluation access only if the provider offers that separation.
5. Finish the selected-provider transport and budgeted Jev adapter using mocks first; run a separately authorized bounded feed acceptance test, then a capped Jev latency test, then the paper session. Retain the old halted accounts and choose a separately identified diagnostic account only by an explicit recovery decision. Report both accepted and rejected/stale decisions, full costs and all stops.

No strategy change, real trading, merge, deployment, public exposure, schedule, purchase or credential setup is authorized by this document. PR #2 stays draft. A future live Jev setup would still need provider access/budget, measured latency and guarded Jev integration. The selected free offline workflow does not depend on those choices.
