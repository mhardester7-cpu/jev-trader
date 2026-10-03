// Offline ABI encoding regression. No wallet, key, signing, or RPC.
import { ethers } from "ethers";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { config } from "../src/config";
import { Market } from "../src/market";
import { frame } from "../tests/fixtures";

const iface = new ethers.utils.Interface(OrderBookAbi.abi);

const market = new Market();
market.params = { pricePrecision: ethers.BigNumber.from(100000000), sizePrecision: ethers.BigNumber.from("10000000000"), tickSize: ethers.BigNumber.from(100) } as typeof market.params;
const book = frame(1).book;
const size = config.tradeSizeMon;
const priceDec = market.params.pricePrecision.toString().length - 1, sizeDec = market.params.sizePrecision.toString().length - 1;
const tick = Number(market.params.tickSize.toString());
console.log(`market ${config.market} · block ${book.block} · bid ${book.bid} ask ${book.ask} · tick ${tick / 10 ** priceDec} · size ${size} MON · ${config.quoteInsideTicks} tick inside`);
console.log("offline fixture, no wallet");

let failed = false;
const check = (label: string, ok: boolean) => { console.log(`${ok ? "ok  " : "FAIL"} ${label}`); if (!ok) failed = true; };
for (const side of ["buy", "sell"] as const) {
  const price = market.quotePrice(side, book);
  const cancel = [123, 456];
  const tx = market.buildTx(side, size, price, cancel);
  const d = iface.decodeFunctionData("batchUpdate", tx.data!);
  // ethers decodes uint32 as number and uint96/uint40 as BigNumber; normalise everything to BigNumber.
  const bn = (xs: unknown[]) => xs.map((x) => ethers.BigNumber.from(x as ethers.BigNumberish));
  const [bp, bs, sp, ss, ids] = [bn(d[0]), bn(d[1]), bn(d[2]), bn(d[3]), bn(d[4])];
  const postOnly = d[5] as boolean;
  const prices = side === "buy" ? bp : sp, sizes = side === "buy" ? bs : ss, otherPrices = side === "buy" ? sp : bp;
  console.log(`${side}: price ${price} → ${prices.map(String)} units · size ${sizes.map(String)} · cancel ${ids.map(String)} · postOnly ${postOnly}`);
  check(`${side} one order on our side, none on the other`, prices.length === 1 && otherPrices.length === 0);
  check(`${side} price is on a tick`, prices[0]!.mod(tick).isZero());
  check(`${side} price is ${price}`, prices[0]!.eq(Math.round(price * 10 ** priceDec)));
  check(`${side} does not cross`, side === "buy" ? price < book.ask : price > book.bid);
  check(`${side} is at or inside the touch`, side === "buy" ? price >= book.bid : price <= book.ask);
  check(`${side} size is ${size} MON`, sizes[0]!.eq(ethers.utils.parseUnits(String(size), sizeDec)));
  check(`${side} cancels ${cancel}`, ids.length === 2 && ids[0]!.eq(123) && ids[1]!.eq(456));
  check(`${side} post only`, postOnly === true);
  check(`${side} value is 0 (margin funded)`, ethers.BigNumber.from(tx.value).isZero());
  check(`${side} type-2 to the market`, tx.type === 2 && String(tx.to).toLowerCase() === config.market.toLowerCase());
  console.log();
}
console.log(failed ? "MISMATCH" : "all checks passed");
process.exit(failed ? 1 : 0);
