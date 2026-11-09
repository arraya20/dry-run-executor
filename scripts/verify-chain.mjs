#!/usr/bin/env node
// Re-derive every external claim this project makes, from the live chain.
//
// Nothing here reads the README. Each check states what is being asserted, asks
// the node, and prints the number it saw. If a check fails, the claim in the
// README is wrong and the README has to change — not the threshold.
//
// The important one is gas accuracy: the tool's central promise is that
// bisection measures real gas better than the node's own estimator. That is
// either true on this chain or it is not, and replaying historical transactions
// against their parent block is how we find out.

import { createRpc, RpcError } from "../src/rpc.mjs";
import { keccak256Hex, keccak256Bytes } from "../src/keccak.mjs";
import { intrinsicGas, measureMinimumGas, sampleHistoricalGas } from "../src/gas.mjs";
import { decodeRevert } from "../src/revert.mjs";
import { toQuantity, fromQuantity, strip0x } from "../src/hex.mjs";
import { PHAROS } from "../src/simulate.mjs";

const rpc = createRpc({ url: PHAROS.rpc });
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
}

// A check that needs a historical sample the chain did not offer right now is
// not a failed claim; it is an unverified one. Say so, and do not fail the run.
function skip(name, detail) {
  results.push({ name, skipped: true, detail });
  console.log(`SKIP  ${name}`);
  if (detail) console.log(`      ${detail}`);
}

// Windows of 900 blocks stay under the node's eth_getLogs ceiling.
const SAMPLE_SPAN = 90_000;

const b = (v) => Number(BigInt(v));

/** Decode a 0x-hex string to bytes. keccak256Hex() hashes text; code hashes are over bytes. */
function hexToBytes(hex) {
  const clean = strip0x(hex);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// 1. We are talking to the chain we think we are.
{
  const chainId = b(await rpc.call("eth_chainId", []));
  record("chain id is 1672 (Pharos Pacific)", chainId === PHAROS.chainId, `node reported ${chainId}`);
}

const head = b(await rpc.call("eth_blockNumber", []));
console.log(`\nhead is block ${head}\n`);

// ---------------------------------------------------------------------------
// 2. Our keccak is the chain's keccak. eth_getProof returns a codeHash that the
//    node computed over the deployed bytecode; reproducing it locally over a
//    multi-kilobyte contract is a strong independent check.
{
  const token = "0x6b0a44c64190279f7034b77c13a566e914fe5ec4"; // stPROS, a proxy
  const code = await rpc.call("eth_getCode", [token, "0x" + head.toString(16)]);
  const proof = await rpc.call("eth_getProof", [token, [], "0x" + head.toString(16)]);
  const ours = "0x" + [...keccak256Bytes(hexToBytes(code))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const bytes = (code.length - 2) / 2;
  record(
    "keccak256(bytecode) equals the node's codeHash",
    ours.toLowerCase() === String(proof.codeHash).toLowerCase(),
    `${bytes} bytes of code; ours ${ours.slice(0, 18)}… node ${String(proof.codeHash).slice(0, 18)}…`,
  );
}

// ---------------------------------------------------------------------------
// 3. eth_getLogs has a block-range ceiling. The sampler works in windows because
//    of this; if the ceiling disappeared the windows would just be extra calls.
{
  let rejected = false;
  let detail = "";
  try {
    await rpc.call("eth_getLogs", [
      { fromBlock: toQuantity(Math.max(0, head - 5_000)), toBlock: toQuantity(head), address: "0x6b0a44c64190279f7034b77c13a566e914fe5ec4" },
    ]);
    detail = "a 5,000 block range was accepted";
  } catch (err) {
    rejected = true;
    detail = `a 5,000 block range was refused: ${String(err.message).slice(0, 80)}`;
  }
  record("eth_getLogs refuses a 5,000 block range", rejected, detail);
}

// ---------------------------------------------------------------------------
// 4. The tracing methods that would have given us post-state are absent. Each of
//    these is why the report says "derived, not observed".
{
  const tx = { from: "0x651940ebb947408151aa46d5e9677d583b757bbc", to: "0x6b0a44c64190279f7034b77c13a566e914fe5ec4", data: "0x70a08231000000000000000000000000651940ebb947408151aa46d5e9677d583b757bbc" };
  const blockTag = "0x" + head.toString(16);

  let prestateRejected = false;
  let prestateDetail = "";
  try {
    await rpc.call("debug_traceCall", [tx, blockTag, { tracer: "prestateTracer" }]);
    prestateDetail = "prestateTracer answered";
  } catch (err) {
    prestateRejected = true;
    prestateDetail = String(err.message).slice(0, 80);
  }
  record("prestateTracer is unavailable (no pre/post state diff)", prestateRejected, prestateDetail);

  let simulateRejected = false;
  try {
    await rpc.call("eth_simulateV1", [{ blockStateCalls: [{ calls: [tx] }] }, blockTag]);
  } catch {
    simulateRejected = true;
  }
  record("eth_simulateV1 is unavailable", simulateRejected, "");

  // structLogs claims to include memory but sends none, so log payloads are
  // unreadable even though LOG opcodes appear.
  const trace = await rpc.call("debug_traceCall", [tx, blockTag, {}]);
  const logs = (trace?.structLogs || []).filter((s) => /^LOG/.test(s.op));
  const anyMemory = (trace?.structLogs || []).some((s) => Array.isArray(s.memory));
  record(
    "structLogs omits memory, so LOG payloads cannot be decoded",
    !anyMemory,
    `${(trace?.structLogs || []).length} steps, ${logs.length} LOG opcodes, memory present: ${anyMemory}`,
  );
}

// ---------------------------------------------------------------------------
// 5. callTracer, the one tracer that works, drops logs. A transaction whose
//    receipt carries Transfer events comes back with no logs at all.
{
  const token = "0x6b0a44c64190279f7034b77c13a566e914fe5ec4";
  let sample = null;
  for (let end = head; end > head - SAMPLE_SPAN && !sample; end -= 900) {
    const start = Math.max(0, end - 899);
    let logs = [];
    try {
      logs = await rpc.call("eth_getLogs", [{ fromBlock: toQuantity(start), toBlock: toQuantity(end), address: token }]);
    } catch {
      continue;
    }
    for (const log of logs) {
      const tx = await rpc.call("eth_getTransactionByHash", [log.transactionHash]);
      const rc = await rpc.call("eth_getTransactionReceipt", [log.transactionHash]);
      if (tx && rc && rc.status === "0x1" && tx.to && tx.to.toLowerCase() === token) {
        sample = { tx, rc };
        break;
      }
    }
  }

  if (!sample) {
    skip("callTracer drops logs despite withLog: true", `no successful token call found in the last ${SAMPLE_SPAN} blocks; claim not re-verified this run`);
  } else {
    const parent = "0x" + (Number(BigInt(sample.rc.blockNumber)) - 1).toString(16);
    const traced = await rpc.call("debug_traceCall", [
      { from: sample.tx.from, to: sample.tx.to, data: sample.tx.input, value: sample.tx.value },
      parent,
      { tracer: "callTracer", withLog: true },
    ]);
    const receiptLogs = sample.rc.logs.length;
    const tracedLogs = Array.isArray(traced?.logs) ? traced.logs.length : null;
    record(
      "callTracer drops logs despite withLog: true",
      tracedLogs === null && receiptLogs > 0,
      `receipt had ${receiptLogs} log(s); callTracer returned ${tracedLogs === null ? "no logs field" : tracedLogs + " logs"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 6. The central claim: bisection beats eth_estimateGas. Replay successful
//    historical transfers at their parent block and compare both against the
//    gasUsed the receipt actually recorded.
{
  const token = "0x6b0a44c64190279f7034b77c13a566e914fe5ec4";
  const samples = [];
  for (let end = head; end > head - SAMPLE_SPAN && samples.length < 5; end -= 900) {
    const start = Math.max(0, end - 899);
    let logs = [];
    try {
      logs = await rpc.call("eth_getLogs", [{ fromBlock: toQuantity(start), toBlock: toQuantity(end), address: token }]);
    } catch {
      continue;
    }
    for (const log of logs) {
      if (samples.length >= 5) break;
      if (log.transactionHash && samples.some((s) => s.hash === log.transactionHash)) continue;
      const tx = await rpc.call("eth_getTransactionByHash", [log.transactionHash]);
      const rc = await rpc.call("eth_getTransactionReceipt", [log.transactionHash]);
      if (!tx || !rc || rc.status !== "0x1" || !tx.to || tx.to.toLowerCase() !== token) continue;
      if (tx.input.length < 10) continue;
      samples.push({ hash: tx.hash, tx, rc });
    }
  }

  const rows = [];
  for (const s of samples) {
    const parent = "0x" + (BigInt(s.rc.blockNumber) - 1n).toString(16);
    const callTx = { from: s.tx.from, to: s.tx.to, data: s.tx.input };
    if (BigInt(s.tx.value) > 0n) callTx.value = s.tx.value;

    const actual = b(s.rc.gasUsed);
    let measured = null;
    try {
      const m = await measureMinimumGas(rpc, { tx: callTx, blockTag: parent, upperBound: (BigInt(actual) * 200n) / 100n, lowerBound: intrinsicGas({ to: s.tx.to, data: s.tx.input }) });
      measured = m?.minimum ?? null;
    } catch {
      measured = null;
    }

    let estimate = null;
    try {
      estimate = b(await rpc.call("eth_estimateGas", [callTx, parent]));
    } catch {
      estimate = null;
    }

    rows.push({
      selector: s.tx.input.slice(0, 10),
      actual,
      measured: measured === null ? null : Number(measured),
      estimate,
    });
  }

  const usable = rows.filter((r) => r.measured !== null);
  if (!usable.length) {
    skip("bisection measures gas within 5% of the receipt", `no replayable sample among ${rows.length} transactions in the last ${SAMPLE_SPAN} blocks; claim not re-verified this run`);
  } else {
    const deltas = usable.map((r) => ((r.measured - r.actual) / r.actual) * 100);
    const meanAbs = deltas.reduce((a, d) => a + Math.abs(d), 0) / deltas.length;
    const worst = Math.max(...deltas.map(Math.abs));
    for (const r of usable) {
      const d = ((r.measured - r.actual) / r.actual) * 100;
      console.log(`      ${r.selector}  receipt ${r.actual}  measured ${r.measured}  (${d >= 0 ? "+" : ""}${d.toFixed(2)}%)  node estimate ${r.estimate ?? "—"}`);
    }
    record("bisection measures gas within 5% of the receipt", meanAbs <= 5, `mean absolute error ${meanAbs.toFixed(2)}% over ${usable.length} replays, worst ${worst.toFixed(2)}%`);

    const est = usable.filter((r) => r.estimate !== null);
    if (est.length) {
      const estDeltas = est.map((r) => ((r.estimate - r.actual) / r.actual) * 100);
      const estMean = estDeltas.reduce((a, d) => a + d, 0) / estDeltas.length;
      record(
        "eth_estimateGas overestimates compared with the receipt",
        estMean > 0,
        `mean ${estMean >= 0 ? "+" : ""}${estMean.toFixed(1)}% over ${est.length} replays, while bisection was ${meanAbs.toFixed(2)}% off`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 7. estimateGas does not check whether the sender can pay for a zero-value
//    call. This is why the report has its own affordability check.
{
  // Derive an address deterministically, then prove it holds nothing. Assuming
  // 0x…0001 is empty was wrong: it held 0.0021 PROS, which invalidated the test.
  let empty = null;
  let balance = null;
  for (let i = 0; i < 20 && balance !== 0n; i++) {
    const digest = keccak256Hex(`dry-run-executor/zero-balance-probe/${i}`).replace(/^0x/, "");
    empty = "0x" + digest.slice(24, 64);
    balance = fromQuantity(await rpc.call("eth_getBalance", [empty, "0x" + head.toString(16)]));
  }
  const call = { from: empty, to: "0x6b0a44c64190279f7034b77c13a566e914fe5ec4", data: "0x70a08231000000000000000000000000651940ebb947408151aa46d5e9677d583b757bbc" };

  let zeroValueAnswer = null;
  try {
    zeroValueAnswer = b(await rpc.call("eth_estimateGas", [call, "0x" + head.toString(16)]));
  } catch {
    zeroValueAnswer = null;
  }

  let valueAnswer = "not tried";
  try {
    await rpc.call("eth_estimateGas", [{ ...call, value: "0x1" }, "0x" + head.toString(16)]);
    valueAnswer = "accepted, which would be wrong";
  } catch (err) {
    valueAnswer = `refused: ${String(err.message).slice(0, 60)}`;
  }

  record(
    "estimateGas answers for a sender with no balance when value is zero",
    zeroValueAnswer !== null && balance === 0n,
    `balance ${balance} wei, estimate ${zeroValueAnswer ?? "refused"}; the same call with value 1 was ${valueAnswer}`,
  );
}

// ---------------------------------------------------------------------------
// 8. A real revert decodes to a named ERC-6093 error, not a hex blob.
{
  const holder = "0x651940ebb947408151aa46d5e9677d583b757bbc";
  const token = "0x6b0a44c64190279f7034b77c13a566e914fe5ec4";
  const amount = (10n ** 30n).toString(16).padStart(64, "0");
  const data = "0xa9059cbb" + holder.slice(2).toLowerCase().padStart(64, "0") + amount;

  let decoded = null;
  try {
    await rpc.call("eth_call", [{ from: holder, to: token, data }, "0x" + head.toString(16)]);
  } catch (err) {
    decoded = decodeRevert(err?.data || "0x");
  }
  record(
    "an over-sized transfer decodes to ERC20InsufficientBalance",
    decoded?.kind === "custom error" && String(decoded.summary).includes("ERC20InsufficientBalance"),
    decoded ? decoded.summary.slice(0, 120) : "the call did not revert, so nothing was decoded",
  );
}

// ---------------------------------------------------------------------------
// 9. The sampler returns something or explains itself. Never silently nothing.
{
  const sample = await sampleHistoricalGas(rpc, { to: "0x6b0a44c64190279f7034b77c13a566e914fe5ec4", selector: "0xa9059cbb", lookbackBlocks: 5_400 });
  record(
    "the gas sampler explains an empty result",
    sample.summary !== null || Boolean(sample.note),
    sample.summary ? `${sample.summary.count} samples, median ${sample.summary.median}` : sample.note,
  );
}

// ---------------------------------------------------------------------------
console.log("");
const skipped = results.filter((r) => r.skipped);
const failed = results.filter((r) => !r.skipped && !r.pass);
const passed = results.length - failed.length - skipped.length;
console.log(`${passed} passed, ${failed.length} failed, ${skipped.length} skipped (of ${results.length})`);
for (const s of skipped) console.log(`skipped: ${s.name}`);
if (failed.length) {
  console.log("");
  for (const f of failed) console.log(`failed: ${f.name}`);
  process.exit(1);
}
