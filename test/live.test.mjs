// Live tests. Opt-in via `npm run test:live`.
//
// These assert SHAPE, never a specific verdict. A verdict depends on chain state
// that moves every block; pinning one here would mean a test that fails for a
// reason unrelated to the code. What is checked is that the report is complete,
// internally consistent, and honest about its own gaps on the real network.

import { suite, test, run, ok, eq } from "./harness.mjs";
import { dryRun, PHAROS } from "../src/simulate.mjs";

suite("live");

const VERDICTS = new Set(["READY", "WILL-REVERT", "INSUFFICIENT-FUNDS", "INCOMPLETE"]);
const TOKEN = "0x6b0a44c64190279f7034b77c13a566e914fe5ec4";
const HOLDER = "0x651940ebb947408151aa46d5e9677d583b757bbc";
const EOA = "0x000000000000000000000000000000000000dEaD";

const pad = (v) => BigInt(v).toString(16).padStart(64, "0");
const transferData = (to, amount) => "0xa9059cbb" + to.slice(2).toLowerCase().padStart(64, "0") + pad(amount);

let cached = null;
const once = async () => {
  if (!cached) cached = await dryRun({ from: HOLDER, to: TOKEN, data: transferData(HOLDER, 10n ** 18n) });
  return cached;
};

test("the tool talks to the chain it claims", async () => {
  const report = await once();
  eq(report.chain.id, PHAROS.chainId);
  ok(report.chain.block > 0, "a block number is pinned");
});

test("every report carries one of the four verdicts", async () => {
  const report = await once();
  ok(VERDICTS.has(report.verdict), `unexpected verdict ${report.verdict}`);
});

test("gas is measured, not merely estimated", async () => {
  const report = await once();
  ok(report.gas.expectedIsMeasured, "expected gas must come from bisection on a live node");
  ok(Number(report.gas.measuredProbes) > 0, "probes must be counted");
  ok(BigInt(report.gas.limit) >= BigInt(report.gas.expected), "the limit must not sit below the measurement");
});

test("the node's own estimate is reported separately from the measurement", async () => {
  const report = await once();
  ok(report.gas.nodeEstimate !== null, "the node estimate is recorded for comparison");
  ok(
    report.gas.nodeEstimateOverMeasuredPercent === null || typeof report.gas.nodeEstimateOverMeasuredPercent === "number",
    "the gap is either measured or absent",
  );
});

test("intrinsic gas never exceeds the measured requirement", async () => {
  const report = await once();
  ok(BigInt(report.gas.intrinsic) <= BigInt(report.gas.expected), "intrinsic is a floor, so it cannot exceed the measurement");
});

test("cost is derived from the measured gas and the quoted fee", async () => {
  const report = await once();
  ok(BigInt(report.cost.expectedWei) > 0n);
  ok(BigInt(report.fees.maxFeePerGas) > 0n);
  eq(
    BigInt(report.cost.expectedWei),
    BigInt(report.gas.expected) * BigInt(report.fees.maxFeePerGas),
    "expected cost must be gas times fee",
  );
});

test("affordability is computed from the real balance", async () => {
  const report = await once();
  eq(report.funding.sufficient, BigInt(report.account.balanceWei) >= BigInt(report.funding.requiredWei));
});

test("a token transfer is recognised and its token is read", async () => {
  const report = await once();
  eq(report.intent.kind, "erc20-transfer");
  ok(report.token !== null, "token context must be present for a token op");
  ok(report.token.decimals !== null, "decimals must be readable");
});

test("a transfer larger than the balance reverts with a named error", async () => {
  const report = await dryRun({ from: HOLDER, to: TOKEN, data: transferData(HOLDER, 10n ** 30n) });
  eq(report.execution.status, "reverts");
  eq(report.verdict, "WILL-REVERT");
  ok(report.execution.revert.kind !== "unknown", "the revert must be decoded, not just reported as hex");
});

test("a value transfer to an address with no code succeeds", async () => {
  // The sender has to actually hold native balance: a value transfer from an
  // empty account is refused by the node before any gas question arises, and
  // asserting on HOLDER failed for exactly that reason.
  //
  // Pharos is quiet — recent blocks are often empty and a 900 block log range
  // can contain nothing at all — so this probes a few known-active addresses
  // first and only then widens the search window by window.
  const { createRpc } = await import("../src/rpc.mjs");
  const { fromQuantity, toQuantity } = await import("../src/hex.mjs");
  const rpc = createRpc({ url: PHAROS.rpc });

  const CANDIDATES = [
    "0x25fdb4a165661f07cb52ac55d00d8d191126b058",
    "0x651940ebb947408151aa46d5e9677d583b757bbc",
  ];

  const balanceOf = async (addr) => fromQuantity(await rpc.call("eth_getBalance", [addr, "latest"]));

  let funded = null;
  for (const addr of CANDIDATES) {
    if ((await balanceOf(addr)) > 10n ** 15n) {
      funded = addr;
      break;
    }
  }

  if (!funded) {
    const head = Number(fromQuantity(await rpc.call("eth_blockNumber", [])));
    outer: for (let end = head; end > head - 10_800; end -= 900) {
      const logs = await rpc
        .call("eth_getLogs", [{ fromBlock: toQuantity(end - 899), toBlock: toQuantity(end), address: TOKEN }])
        .catch(() => []);
      for (const hash of [...new Set(logs.map((l) => l.transactionHash))].slice(0, 10)) {
        const tx = await rpc.call("eth_getTransactionByHash", [hash]);
        if (!tx?.from) continue;
        if ((await balanceOf(tx.from)) > 10n ** 15n) {
          funded = tx.from;
          break outer;
        }
      }
    }
  }

  const report = await dryRun({ from: funded, to: EOA, value: "1" });
  eq(report.execution.status, "succeeds");
  eq(report.gas.expected, "21000", "a bare transfer costs exactly the intrinsic floor");
  eq(report.target.isContract, false, "the recipient has no code");
  eq(report.verdict, "READY");
});

test("the not-measured list is never empty", async () => {
  const report = await once();
  ok(Array.isArray(report.notMeasured) && report.notMeasured.length >= 3, "the gaps must always be stated");
  ok(report.notMeasured.some((n) => n.includes("post-state")), "post-state honesty is mandatory");
});

test("a caller-supplied verdict is refused on a live call too", async () => {
  let refused = false;
  try {
    await dryRun({ from: HOLDER, to: TOKEN, mockRevert: true });
  } catch (err) {
    refused = /mockRevert/.test(err.message);
  }
  ok(refused, "the refusal must name the field");
});

test("the report survives JSON round trip", async () => {
  const report = await once();
  const parsed = JSON.parse(JSON.stringify(report));
  eq(parsed.verdict, report.verdict);
  eq(typeof parsed.gas.expected, "string");
});

test("the submit payload is never signed", async () => {
  const report = await once();
  ok(!("signature" in report.submit), "no signature");
  ok(!("signedTransaction" in report.submit), "no signed payload");
  eq(report.submit.chainId, PHAROS.chainId);
});

test("the block is pinned consistently across every read", async () => {
  const report = await once();
  ok(Number(report.chain.block) > 0);
  // The same request twice in a row must not silently mix two different blocks
  // if the head has not moved; at minimum both reports must name a block.
  const second = await dryRun({ from: HOLDER, to: TOKEN, data: transferData(HOLDER, 10n ** 18n) });
  ok(Number(second.chain.block) >= Number(report.chain.block), "blocks move forward");
  ok(second.gas.intrinsic === report.gas.intrinsic, "same calldata, same intrinsic floor");
});

const failures = await run();
process.exit(failures === 0 ? 0 : 1);
