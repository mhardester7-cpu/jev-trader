# Local Jev paper dashboard

The dashboard uses **real Jev responses with recorded MON-USDC data**, while all orders and fills remain simulated. It starts idle. It does not start a mock strategy, live RPC feed or model call when opened. No real Jev call has yet been verified: the user must supply a key privately and authorize the run's inference budget first.

## Open on the Mac

Install the locked dependencies once, without lifecycle scripts, if needed:

```sh
bun install --frozen-lockfile --ignore-scripts
cd web
bun install --frozen-lockfile --ignore-scripts
cd ..
bun run paper:dashboard
```

Open **http://127.0.0.1:3001** on that Mac. The launcher starts the existing Next dashboard and a paper API at `127.0.0.1:8787`. Both bind only to loopback. It removes the old Railway feed from the dashboard's default path and uses a fixed same-origin local proxy. Next telemetry is disabled and fonts use the local system. No public hosting, tunnel, deployment or browser storage is configured.

The page shows readiness, model, source dates, paper P&L after estimated liquidation costs, request count, reported model cost and reserved budget. Price, decision and fill panels populate only after a Jev test starts. An idle screen is not a failed trading loop. The status stream being connected does not mean the model has been authenticated.

## Private key entry and approval

Enter the TypeSafe/Jev API key into the password field **on this Mac**. Do not paste it into chat, a command, source code or a `.env` file. The browser clears the field on submission. The app sends the key only to the same-origin loopback server and then to TypeSafe's fixed HTTPS evaluation endpoint. It keeps the key only in memory for the bounded run, never writes it to session files or browser storage, never returns it in a response, and releases its reference when the run ends. No existing key or persistent credential store is inspected.

The initial proposal is **up to 10 model requests, $0.03, and two minutes**. The checkbox and Start action authorize that specific new run. Opening the page does not grant that authorization. Each run starts a clearly identified new $100 paper experiment; it does not reset or continue the older live-feed ledgers. Re-running requires entering the key and authorizing another run.

TypeSafe's [model documentation](https://docs.typesafe.ai/models), checked 2026-10-04, lists `jev-1.13.0` at $0.042 per million input tokens, output free, with a 64k-token request context. The app conservatively interprets that as 65,536 tokens and reserves **$0.002752512 before every attempted request**. Ten attempts reserve at most $0.02752512. Reservations are never recycled when a response uses fewer tokens; timeouts and unknown usage retain the full reservation. Integer nanodollar arithmetic prevents rounding past the approved cap. Request, budget and wall-time gates run before each call; only one call can be in flight. Larger UI selections are still limited by the smaller of the request and reservation budgets, up to 449 requests and $1.25 per run.

This enforces a local request/reservation ceiling **at the published model terms**, not a provider-side account billing cap. It does not cover other users of the same API key or an unexpected provider price/billing change. Check current provider terms before future use and use an account-level limit if available. No scoped evaluation key or provider-enforced per-request dollar cap was verified. Only model evaluation access is needed; no wallet, signer, brokerage, RPC credential, billing-management permission or trading permission is needed.

The [official API](https://docs.typesafe.ai/api) is `POST https://api.typesafe.ai/v1/systemone` with bearer authentication. This path pins the model and shares the existing strategy question. It uses no redirects or automatic retries. Responses must identify the pinned model, include usable token usage and return valid buy/sell probabilities. Any provider error, invalid response or unknown usage stops the run; there is no mock fallback. Unknown model cost is conservatively included in paper P&L and separately flagged for billing reconciliation.

## What a test means

The source is the same verified 600-block historical recording from 2026-09-17. Loading the dashboard checks the raw cache and normalized hashes without evaluating a strategy. The first 150 blocks warm the original 100-block feature horizon. Then each completed historical block feeds the actual Jev request; a resulting paper order is eligible only in the next recorded block, with the existing cash, inventory, cost, stop and loss controls.

Playback waits for each model response and records its latency. It does not impose or demonstrate the live loop's 300 ms feed-plus-inference deadline. This is a historical Jev experiment, not live market trading or a claim of out-of-sample predictive performance. The recorded interval is very short and the first ten-call trial is an integration check, not a profitability sample. Market data is free here; Jev inference may be billable. Actual Jev quality, latency, account access and billing remain unverified until a separately approved real run succeeds.

`data/jev-recorded/<run UUID>/account.json` preserves the source hash, limits, attempts/reservations, accounted cost, paper ledger, cursor and terminal state. `events.jsonl` stores causal events, decisions, reported token counts and request hashes, without keys or raw provider error bodies. The reservation checkpoint is written before sending a request. There is no automatic recovery or restart; an interrupted run's last checkpoint must be reviewed. Previous runs and the older halted public accounts are preserved.

## Stop and phone access

Use **Stop Jev test** to abort an in-flight request and prevent further orders. A provider may still bill an aborted request; its reservation remains. Limits continue to apply even if the browser tab closes. At stop, the last observed paper inventory is retained and valued; the app does not invent a liquidation at an unobserved price. To stop the entire dashboard, press **Ctrl+C** in its terminal. The launcher stops its own UI and API processes and records their state in `data/dashboard-process.json`.

The URL above works only on the Mac. A phone cannot reach the Mac by opening its own `127.0.0.1`. The responsive screenshot can be viewed in the conversation immediately. Interactive phone use would need a separately approved private connection (for example, an existing trusted remote-desktop or authenticated private-network route), with suitable transport and origin controls. No such route is assumed, installed or exposed here. Do not simply bind the key-entry app to `0.0.0.0` or open an unauthenticated public tunnel.

## Verified without a key

The new guarded-Jev tests pass **10 tests / 73 assertions**, using explicit provider-response fixtures with external fetch disabled. They cover full-context reservations, request/time limits, no retries, provider error redaction, malformed answers, missing usage, persistence before send, stop during a request, local-origin/CSRF guards and credential-free disk output. These are adapter/control tests, not a mock trading run or real Jev results. Root and web TypeScript checks and real desktop/390px browser inspection pass. The idle UI and status endpoint respond locally with zero model attempts.
