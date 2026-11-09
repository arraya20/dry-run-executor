// Offline unit tests. No network, no install, no framework.
//
// Everything here is deterministic arithmetic or decoding. The live behaviour
// (does the node really answer these calls) is covered by test/live.test.mjs and
// the capability claims are proved by scripts/verify-chain.mjs.

import { suite, test, run, ok, eq, throws, includes } from "./harness.mjs";

import {
  keccak256Bytes as keccak256,
  keccak256Hex as keccakHex,
  selector as selectorOf,
} from "../src/keccak.mjs";
import { toQuantity, fromQuantity, isAddress, wordToBigInt, padWord, strip0x } from "../src/hex.mjs";
import { decodeRevert, PANIC_CODES } from "../src/revert.mjs";
import { decodeIntent } from "../src/intent.mjs";
import { intrinsicGas, planGas, percentile, quoteFees } from "../src/gas.mjs";
import { validateRequest, RequestError, formatPROS, formatTokenAmount, assertReady, executeIfReady, ExecutionBlockedError } from "../src/simulate.mjs";

suite("unit");

// ---------------------------------------------------------------- keccak
// Published vectors. If these pass, the permutation and the 0x01 padding are
// both right; the Ethereum-vs-NIST padding mistake cannot hide here.
const digest = (text) => keccakHex(text).replace(/^0x/, "");

test("keccak256 known vectors", () => {
  eq(digest(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "empty string");
  eq(digest("abc"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45", "abc");
  eq(
    digest("The quick brown fox jumps over the lazy dog"),
    "4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15",
    "quick brown fox",
  );
});

test("keccak256 differs from sha3-256 padding", () => {
  // A wrong 0x06 padding byte produces this digest instead. Asserting the absence
  // is the cheapest possible guard against that specific bug.
  const wrong = digest("");
  ok(wrong !== "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a", "must not match SHA3-256");
});

test("function selectors match the canonical values", () => {
  eq(selectorOf("transfer(address,uint256)"), "0xa9059cbb");
  eq(selectorOf("balanceOf(address)"), "0x70a08231");
  eq(selectorOf("approve(address,uint256)"), "0x095ea7b3");
  eq(selectorOf("transferFrom(address,address,uint256)"), "0x23b872dd");
});

test("ERC-6093 selector matches the value the chain actually returned", () => {
  // Taken from a real revert on Pharos, not from a table in this repo. If keccak
  // and the signature disagree, the decoder silently stops finding this error.
  eq(selectorOf("ERC20InsufficientBalance(address,uint256,uint256)"), "0xe450d38c");
  eq(selectorOf("Error(string)"), "0x08c379a0");
  eq(selectorOf("Panic(uint256)"), "0x4e487b71");
});

test("keccak256 returns 32 bytes", () => {
  const out = keccak256(new TextEncoder().encode("test"));
  ok(out instanceof Uint8Array, "returns bytes");
  eq(out.length, 32);
});

// ---------------------------------------------------------------- hex
test("quantity round trip", () => {
  eq(toQuantity(0n), "0x0");
  eq(toQuantity(255n), "0xff");
  eq(toQuantity(1_000_000n), "0xf4240");
  eq(fromQuantity("0x0"), 0n);
  eq(fromQuantity("0x1"), 1n);
  eq(fromQuantity("0xf4240"), 1_000_000n);
});

test("fromQuantity refuses to invent a zero", () => {
  // A missing field returning 0n would silently turn "unknown balance" into
  // "no balance", which is exactly the kind of fake certainty this tool avoids.
  for (const bad of [null, undefined, "", "f4240"]) {
    let threw = false;
    try {
      fromQuantity(bad);
    } catch {
      threw = true;
    }
    ok(threw, `${JSON.stringify(bad)} must be refused rather than read as zero`);
  }
});

test("address validation rejects malformed input", () => {
  ok(isAddress("0x5357FC32213618B64949c9f500A6cb87C6249f67"), "checksummed");
  ok(isAddress("0x5357fc32213618b64949c9f500a6cb87c6249f67"), "lowercase");
  ok(!isAddress("0x5357fc32213618b64949c9f500a6cb87c6249f6"), "too short");
  ok(!isAddress("5357fc32213618b64949c9f500a6cb87c6249f67"), "missing prefix");
  ok(!isAddress("0xZZZ7fc32213618b64949c9f500a6cb87c6249f67"), "non hex");
  ok(!isAddress(42), "not a string");
});

test("abi word helpers", () => {
  eq(padWord("0x5357FC32213618B64949c9f500A6cb87C6249f67").length, 64);
  eq(wordToBigInt("0x" + "0".repeat(63) + "1"), 1n);
  eq(strip0x("0xab"), "ab");
});

// ---------------------------------------------------------------- revert
test("Error(string) is decoded to the message", () => {
  // require(false, "nope")
  const data =
    "0x08c379a0" +
    "0000000000000000000000000000000000000000000000000000000000000020" +
    "0000000000000000000000000000000000000000000000000000000000000004" +
    "6e6f7065000000000000000000000000000000000000000000000000000000";
  const decoded = decodeRevert(data);
  eq(decoded.kind, "Error(string)");
  includes(decoded.summary, "nope");
});

test("Panic(uint256) maps to a known cause", () => {
  const data = "0x4e487b71" + "0".repeat(62) + "11"; // 0x11 arithmetic overflow
  const decoded = decodeRevert(data);
  eq(decoded.kind, "Panic(uint256)");
  includes(decoded.summary, PANIC_CODES[0x11]);
});

test("a real ERC20InsufficientBalance revert decodes with its values", () => {
  const data =
    "0xe450d38c" +
    "000000000000000000000000651940ebb947408151aa46d5e9677d583b757bbc" +
    "00000000000000000000000000000000000000000000004b8f0b0c9d8b0e04c4" +
    "0000000000000000000000000000000000000000000000d3c21bcecceda1000000";
  const decoded = decodeRevert(data);
  eq(decoded.kind, "custom error");
  includes(decoded.summary, "ERC20InsufficientBalance");
  includes(decoded.summary, "0x651940ebb947408151aa46d5e9677d583b757bbc");
});

test("an empty revert is reported as empty, not as success", () => {
  const decoded = decodeRevert("0x");
  eq(decoded.kind, "empty");
  ok(decoded.summary.length > 0, "must still say something");
  eq(decoded.raw, "0x", "the empty payload is still explicit");
});

test("an unknown selector keeps the raw bytes instead of guessing", () => {
  const decoded = decodeRevert("0xdeadbeef" + "00".repeat(32));
  eq(decoded.kind, "unknown");
  includes(decoded.raw, "deadbeef");
  includes(decoded.summary, "deadbeef");
});

// ---------------------------------------------------------------- intent
const addr = (hex) => "0x" + hex.repeat(40 / hex.length);
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const token = "0x6b0a44c64190279f7034b77c13a566e914fe5ec4";
const alice = "0x651940ebb947408151aa46d5e9677d583b757bbc";
const bob = "0x000000000000000000000000000000000000dEaD";

test("transfer is decoded with amount and recipient", () => {
  const intent = decodeIntent({ from: alice, to: token, data: "0xa9059cbb" + word("0x651940ebb947408151aa46d5e9677d583b757bbc") + word(10n ** 18n) });
  eq(intent.kind, "erc20-transfer");
  eq(intent.amountWei, (10n ** 18n).toString());
  ok(intent.tokenOp);
});

test("approve of uint256 max is flagged as unlimited", () => {
  const max = 2n ** 256n - 1n;
  const intent = decodeIntent({ from: alice, to: token, data: "0x095ea7b3" + word(bob) + word(max) });
  eq(intent.kind, "erc20-approve");
  ok(intent.scary, "an unlimited approval must be flagged");
  includes(intent.describe, "UNLIMITED");
});

test("approve of zero is a revoke, not a grant", () => {
  const intent = decodeIntent({ from: alice, to: token, data: "0x095ea7b3" + word(bob) + word(0) });
  ok(!intent.scary, "revoking is not scary");
  includes(intent.describe.toLowerCase(), "revoke");
});

test("transferFrom decodes owner and recipient separately", () => {
  const intent = decodeIntent({ from: alice, to: token, data: "0x23b872dd" + word(alice) + word(bob) + word(5n) });
  eq(intent.kind, "erc20-transferFrom");
  eq(intent.amountWei, "5");
  const fields = intent.deltas.map((d) => d.field);
  eq(fields.filter((f) => f === "balance").length, 2, "two balance changes");
  ok(fields.some((f) => f === "allowance"), "the spent allowance is also a change");
});

test("an unknown selector is not treated as a token operation", () => {
  const intent = decodeIntent({ from: alice, to: token, data: "0xdeadbeef" + word(1) });
  eq(intent.kind, "unknown");
  ok(!intent.tokenOp, "must not read token state for unknown calldata");
  eq(intent.selector, "0xdeadbeef");
});

test("a call with no calldata is a native transfer only when it carries value", () => {
  const withValue = decodeIntent({ from: alice, to: bob, data: "0x", value: 1000n });
  eq(withValue.kind, "native-transfer");
  ok(!withValue.tokenOp);
  eq(withValue.deltas.length, 2);

  const withoutValue = decodeIntent({ from: alice, to: bob, data: "0x", value: 0n });
  eq(withoutValue.kind, "empty-call", "sending nothing to nowhere is not a transfer");
});

test("deltas subtract from the sender and add to the recipient", () => {
  const intent = decodeIntent({
    from: alice,
    to: token,
    data: "0xa9059cbb" + word(bob) + word(1000n),
  });
  const fromDelta = intent.deltas.find((d) => d.account.toLowerCase() === alice.toLowerCase());
  const toDelta = intent.deltas.find((d) => d.account.toLowerCase() === bob.toLowerCase());
  eq(fromDelta.change, "-1000");
  eq(toDelta.change, "1000");
});

// ---------------------------------------------------------------- gas
test("intrinsic gas is 21000 for a bare transfer", () => {
  eq(intrinsicGas({ to: bob, data: "0x" }), 21000n);
});

test("intrinsic gas charges 4 per zero byte and 16 per non-zero byte", () => {
  // 0x00 -> 4 ; 0xff -> 16
  eq(intrinsicGas({ to: token, data: "0x00" }), 21004n);
  eq(intrinsicGas({ to: token, data: "0xff" }), 21016n);
});

test("contract creation carries the 32000 surcharge", () => {
  eq(intrinsicGas({ to: null, data: "0x" }), 53000n);
});

test("planGas prefers a measurement over history and history over the node", () => {
  const measured = planGas({ measured: { minimum: 30_000n, probes: 9 }, estimate: 50_000n, intrinsic: 21_000n, history: { median: 40_000n, count: 3 } });
  eq(measured.expectedGas, 30_000n);
  ok(measured.expectedFromMeasurement);
  includes(measured.expectedSource, "bisection");

  const fromHistory = planGas({ measured: null, estimate: 50_000n, intrinsic: 21_000n, history: { median: 40_000n, count: 3 } });
  eq(fromHistory.expectedGas, 40_000n);
  ok(!fromHistory.expectedFromMeasurement);
  includes(fromHistory.expectedSource, "median");

  const fromNode = planGas({ measured: null, estimate: 50_000n, intrinsic: 21_000n, history: null });
  eq(fromNode.expectedGas, 50_000n);
  includes(fromNode.expectedSource, "node estimate");
});

test("planGas adds headroom and never drops below the intrinsic floor", () => {
  const plan = planGas({ measured: { minimum: 30_000n, probes: 5 }, estimate: null, intrinsic: 21_000n, history: null, marginPercent: 10n });
  eq(plan.gasLimit, 33_000n);
  ok(plan.aboveIntrinsic);

  const floored = planGas({ measured: { minimum: 21_000n, probes: 5 }, estimate: null, intrinsic: 21_000n, history: null, marginPercent: 0n });
  eq(floored.gasLimit, 21_000n);
});

test("the node-vs-measured gap is only reported when it was measured", () => {
  const unmeasured = planGas({ measured: null, estimate: 50_000n, intrinsic: 21_000n, history: null });
  eq(unmeasured.nodeEstimateOverMeasuredPercent, null, "no measurement means no gap to report");

  const measured = planGas({ measured: { minimum: 40_000n, probes: 5 }, estimate: 50_000n, intrinsic: 21_000n, history: null });
  eq(measured.nodeEstimateOverMeasuredPercent, 25);
});

test("a feeHistory outage is carried in the source, not silently normalised", async () => {
  const rpc = {
    call: async (method) => {
      if (method === "eth_feeHistory") throw new Error("cu limit exceeded");
      if (method === "eth_gasPrice") return "0x2540be400";
      throw new Error(`unexpected ${method}`);
    },
  };
  const fees = await quoteFees(rpc);
  eq(fees.baseFee, 10_000_000_000n);
  ok(fees.source.includes("feeHistory unavailable"), "the fallback must say why it fell back");
  ok(fees.source.includes("cu limit exceeded"), "the node's own words must survive");
  ok(String(fees.historyFailure).includes("cu limit exceeded"));
});

test("percentile interpolates without going out of range", () => {
  eq(percentile([10n, 20n, 30n, 40n], 50), 20n);
  eq(percentile([5n], 90), 5n);
  eq(percentile([], 50), null);
});

// ---------------------------------------------------------------- request validation
test("a minimal request is accepted", () => {
  const req = validateRequest({ from: alice, to: bob });
  eq(req.from, "0x651940ebb947408151aa46d5e9677d583b757bbc");
  eq(req.value, 0n);
  eq(req.data, "0x");
});

test("a caller-supplied verdict is refused and the field is named", () => {
  const cases = ["mockRevert", "willSucceed", "success", "status", "estimatedGas", "revertReason", "verdict", "predictedGas"];
  for (const field of cases) {
    let error = null;
    try {
      validateRequest({ from: alice, to: bob, [field]: false });
    } catch (err) {
      error = err;
    }
    ok(error instanceof RequestError, `${field} must be refused`);
    includes(error.message, field, `${field} must be named in the error`);
  }
});

test("an unrelated unknown field is also refused", () => {
  const error = (() => {
    try {
      validateRequest({ from: alice, to: bob, flavour: "vanilla" });
      return null;
    } catch (err) {
      return err;
    }
  })();
  ok(error instanceof RequestError, "unknown fields must not be ignored");
  includes(error.message, "flavour");
});

test("a malformed address is refused with the field name", () => {
  const error = (() => {
    try {
      validateRequest({ from: "0xnope", to: bob });
      return null;
    } catch (err) {
      return err;
    }
  })();
  ok(error instanceof RequestError);
  includes(error.message, "from");
});

test("value must be a non-negative base-10 or 0x number", () => {
  eq(validateRequest({ from: alice, to: bob, value: "1000" }).value, 1000n);
  eq(validateRequest({ from: alice, to: bob, value: "0x10" }).value, 16n);
  for (const bad of ["-1", "1.5", "abc"]) {
    let threw = false;
    try {
      validateRequest({ from: alice, to: bob, value: bad });
    } catch {
      threw = true;
    }
    ok(threw, `value ${bad} must be refused`);
  }
});

test("gas below the intrinsic floor is refused", () => {
  let threw = false;
  try {
    validateRequest({ from: alice, to: bob, gas: 1000 });
  } catch (err) {
    threw = /intrinsic/.test(err.message);
  }
  ok(threw, "must mention the intrinsic floor");
});

test("calldata must be 0x-prefixed and even length", () => {
  for (const bad of ["a9059cbb", "0xabc"]) {
    let threw = false;
    try {
      validateRequest({ from: alice, to: bob, data: bad });
    } catch {
      threw = true;
    }
    ok(threw, `data ${bad} must be refused`);
  }
  eq(validateRequest({ from: alice, to: bob, data: "0xa9059cbb" }).data, "0xa9059cbb");
});

// ------------------------------------------------------- amount formatting
// The dashboard exposed this: 1000 wei of value rendered as "0 PROS", so a real
// shortfall appeared as "short by 0 PROS". A formatter must never turn a
// non-zero amount into zero.

test("a non-zero amount never formats as zero", () => {
  eq(formatPROS(1000n), "0.000000000000001");
  eq(formatPROS(0n), "0");
  eq(formatPROS(1n), "0.000000000000000001");
  eq(formatPROS(10n ** 18n), "1");
  eq(formatPROS(1341257465557751648228n), "1341.257465557751648228");
});

test("token amounts keep their significant digits too", () => {
  eq(formatTokenAmount(1n, 6), "0.000001");
  eq(formatTokenAmount(1n, 18), "0.000000000000000001");
  eq(formatTokenAmount(0n, 18), "0");
  eq(formatTokenAmount(1500000n, 6), "1.5");
  eq(formatTokenAmount(2000000n, 6), "2");
});

test("formatting is exact, so no amount is rounded away", () => {
  const wei = 123456789012345678n;
  eq(formatPROS(wei), "0.123456789012345678");
  const [w, f = ""] = formatPROS(wei).split(".");
  eq(BigInt(w) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18)), wei);
});

// ---------------------------------------------------------------- block tag
test("latest and a missing block tag both mean 'pin the head'", () => {
  eq(validateRequest({ from: alice, to: bob }).blockTag, null);
  eq(validateRequest({ from: alice, to: bob, blockTag: "latest" }).blockTag, null);
});

test("a block number is accepted as decimal, 0x, or a safe integer", () => {
  eq(validateRequest({ from: alice, to: bob, blockTag: "22117853" }).blockTag, 22117853n);
  eq(validateRequest({ from: alice, to: bob, blockTag: "0x10" }).blockTag, 16n);
  eq(validateRequest({ from: alice, to: bob, blockTag: 42 }).blockTag, 42n);
  eq(validateRequest({ from: alice, to: bob, blockTag: 0 }).blockTag, 0n);
});

test("a block tag that does not name one block is a RequestError on blockTag", () => {
  for (const bad of ["abc", "pending", "earliest", "safe", "-1", "1.5", "0x", "", -1, 1.5, {}, [], true]) {
    let error = null;
    try {
      validateRequest({ from: alice, to: bob, blockTag: bad });
    } catch (err) {
      error = err;
    }
    ok(error instanceof RequestError, `blockTag ${JSON.stringify(bad)} must be a RequestError, not ${error?.name}`);
    eq(error.field, "blockTag");
  }
});

// ---------------------------------------------------------------- execution gate
const clearedReport = { verdict: "READY", gate: { allowed: true, reasons: [] }, submit: { to: bob, gas: 21000 } };
const blockedReport = {
  verdict: "WILL-REVERT",
  gate: { allowed: false, reasons: ["the call reverts at block 1: nope"] },
  submit: null,
};

test("assertReady returns the payload for a cleared simulation", () => {
  eq(assertReady(clearedReport).gas, 21000);
});

test("assertReady refuses a blocked simulation and says why", async () => {
  const error = await throws(() => assertReady(blockedReport), "WILL-REVERT");
  ok(error instanceof ExecutionBlockedError);
  includes(error.message, "nope");
  eq(error.verdict, "WILL-REVERT");
});

test("a report that claims READY but has no payload or open gate is still refused", async () => {
  await throws(() => assertReady({ verdict: "READY", gate: { allowed: false, reasons: [] }, submit: null }), "blocked");
  await throws(() => assertReady({ verdict: "READY", gate: { allowed: true, reasons: [] }, submit: null }), "blocked");
  await throws(() => assertReady(null), "blocked");
});

test("executeIfReady never calls send for a blocked simulation", async () => {
  let called = false;
  await throws(() => executeIfReady(blockedReport, () => { called = true; }), "blocked");
  ok(!called, "send must not run when the gate is closed");
});

test("executeIfReady hands the unsigned payload to send when cleared", async () => {
  let seen = null;
  const result = await executeIfReady(clearedReport, async (payload) => { seen = payload; return "sent"; });
  eq(result, "sent");
  eq(seen.gas, 21000);
});

// ---------------------------------------------------------------- summary
const failures = await run();
process.exit(failures === 0 ? 0 : 1);
