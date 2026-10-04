# MON-USDC historical recording

600 consecutive Kuru/Monad blocks, 105488246 to 105488845, recorded from the public Goldsky RPC. Market time: 2026-09-17 02:38:53 to 02:41:54 UTC. Retrieval completed on 2026-10-03 with no provider error or retry. The range continued an existing 24-block cache and was selected before strategy results were evaluated.

- `cache.json.gz`: original public RPC results with per-entry checksums and retrieval timestamps; gzip preserves a ~5.3 MB raw cache in ~987 KB.
- `manifest.json`: source, exact range, actual collection receipt, normalized frame hash and raw-cache hash.
- `collection-history.jsonl`: preserved invocation receipt. The 75 reused observations retain their earlier timestamps within the raw cache.
- `frames.jsonl`: decoded complete books and ordered Trade prints for every block, including observed fees, base fees and block hashes.

From the repository root, `bun run paper:free-replay` reconstructs the observations from the raw cache, verifies consistency and prints the fixed base/stress report without network or credentials. See [the guide and limitations](../../docs/FREE_REPLAY.md) and [exact report](../../docs/paper-evaluation.recorded.json). This is a short single-provider sample, not statistically reliable evidence of profitability or real-time feed feasibility.
