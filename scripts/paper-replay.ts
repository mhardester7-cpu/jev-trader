import { evaluate, REPLAY_OPTIONS } from "../src/replay";
import type { PaperFrame } from "../src/paper";

const path = process.argv[2];
if (!path) throw new Error("Usage: bun run paper:replay <frames.jsonl> [warmup=150] [window=150]");
const frames: PaperFrame[] = (await Bun.file(path).text()).trim().split(/\r?\n/).map(line => JSON.parse(line));
const report = evaluate(frames, REPLAY_OPTIONS, Number(process.argv[3] ?? 150), Number(process.argv[4] ?? 150));
console.log(JSON.stringify({ ...report, source: path, warning: "Mock-only simulation. Input provenance and execution assumptions must be verified; these results do not establish profitability." }, null, 2));
