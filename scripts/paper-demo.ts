import { evaluate, REPLAY_OPTIONS } from "../src/replay";
import { syntheticFrames } from "../tests/fixtures";

const frames = syntheticFrames();
console.log(JSON.stringify({
  warning: "SYNTHETIC SOFTWARE CHECK ONLY. Not historical performance, not Jev, no profitability evidence.",
  base: evaluate(frames),
  higherCosts: evaluate(frames, { ...REPLAY_OPTIONS, makerFeeBps: 10, exitFeeBps: 10, slippageBps: 10, gasMon: 0.0714 }),
}, null, 2));
