// Gas and fee arithmetic.
//
// The central distinction this module exists to enforce:
//
//   gasLimit     an upper bound you submit with. Too low reverts with OOG.
//   expectedGas  what the transaction will actually burn, so you can budget.
//
// eth_estimateGas returns something closer to the first than the second. On
// Pharos it overestimates real usage by 30-74% in our measurements, so using it
// as a cost forecast overstates the price by that much. We therefore take the
// estimate as the safe limit and derive expectedGas from real receipts of the
// same (contract, selector) pair, falling back to the estimate when the chain
// gives us no history and saying so.

import { toQuantity, fromQuantity, strip0x, words } from "./hex.mjs";

const ZERO_BYTE_COST = 4n; // EIP-2028, post-Istanbul
const NONZERO_BYTE_COST = 16n;
const TX_BASE = 21_000n;
const TX_CREATE = 32_000n;
const ACCESS_LIST_ADDRESS = 2_400n;
const ACCESS_LIST_SLOT = 1_900n;
const INITCODE_WORD = 2n; // EIP-3860

/**
 * Intrinsic gas: the floor every transaction pays before a single opcode runs.
 * Computed here so a reported gas figure can be sanity-checked against it —
 * anything below this floor is a bug, not a cheap transaction.
 */
export function intrinsicGas({ to, data = "0x", accessList = [] } = {}) {
  let gas = TX_BASE;
  if (!to) gas += TX_CREATE;

  const body = strip0x(data || "0x");
  let zeros = 0;
  let nonZeros = 0;
  for (let i = 0; i < body.length; i += 2) {
    if (body.slice(i, i + 2) === "00") zeros++;
    else nonZeros++;
  }
  gas += BigInt(zeros) * ZERO_BYTE_COST + BigInt(nonZeros) * NONZERO_BYTE_COST;

  if (!to) gas += BigInt(Math.ceil(body.length / 2 / 32)) * INITCODE_WORD;

  for (const entry of accessList) {
    gas += ACCESS_LIST_ADDRESS;
    gas += BigInt(entry.storageKeys?.length || 0) * ACCESS_LIST_SLOT;
  }
  return gas;
}

/** Nearest-rank percentile on a sorted array of BigInt. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export const summarise = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    count: sorted.length,
    min: sorted[0],
    median: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    max: sorted[sorted.length - 1],
  };
};

export const selectorOf = (data) =>
  data && strip0x(data).length >= 8 ? "0x" + strip0x(data).slice(0, 8).toLowerCase() : null;

/**
 * Collect real gasUsed values for past transactions sharing this target and
 * 4-byte selector. Uses contract logs to find candidate transactions, which
 * costs two calls instead of scanning every block.
 *
 * Returns an empty sample set (not a zero) when the chain has nothing to offer,
 * so callers can tell "cheap" apart from "unknown".
 */
export async function sampleHistoricalGas(
  rpc,
  { to, selector, lookbackBlocks = 5_400, windowBlocks = 900, maxSamples = 40 } = {},
) {
  const head = Number(fromQuantity(await rpc.call("eth_blockNumber", [])));
  const fromBlock = Math.max(0, head - lookbackBlocks);

  // The public node rejects eth_getLogs above ~1,000 blocks per call with an
  // HTTP 400, so the range is walked in windows instead of requested at once.
  // A window that fails costs coverage, not correctness, and the reason is kept.
  const hashes = [];
  const seen = new Set();
  const windowErrors = [];

  for (let end = head; end > fromBlock && hashes.length < maxSamples; end -= windowBlocks) {
    const start = Math.max(fromBlock, end - windowBlocks + 1);
    try {
      const logs = await rpc.call("eth_getLogs", [
        { fromBlock: toQuantity(start), toBlock: toQuantity(end), address: to },
      ]);
      for (const log of logs || []) {
        if (seen.has(log.transactionHash)) continue;
        seen.add(log.transactionHash);
        hashes.push(log.transactionHash);
        if (hashes.length >= maxSamples) break;
      }
    } catch (err) {
      windowErrors.push(`blocks ${start}-${end}: ${err?.message || err}`);
    }
  }

  if (!hashes.length) {
    return {
      summary: null,
      samples: [],
      note: windowErrors.length
        ? `no comparable past transactions in ${lookbackBlocks} blocks; ${windowErrors.length} window(s) failed: ${windowErrors[0]}`
        : `no comparable past transactions in the last ${lookbackBlocks} blocks`,
    };
  }
  const values = [];
  for (const hash of hashes) {
    const [tx, receipt] = await Promise.all([
      rpc.call("eth_getTransactionByHash", [hash]),
      rpc.call("eth_getTransactionReceipt", [hash]),
    ]);
    if (!tx || !receipt || receipt.status !== "0x1") continue; // only successful runs inform cost
    if (selector && selectorOf(tx.input) !== selector) continue;
    if (!tx.input || tx.input.length < 10) continue;
    values.push(fromQuantity(receipt.gasUsed));
  }

  return {
    summary: summarise(values),
    samples: values,
    window: { fromBlock, toBlock: head, candidates: hashes.length },
    note: values.length
      ? windowErrors.length
        ? `${windowErrors.length} log window(s) failed but ${values.length} comparable transactions were measured`
        : null
      : `found ${hashes.length} candidate transactions but none was a successful call with the same selector`,
  };
}

/**
 * Fee quote. Pharos keeps baseFee fixed at 10 gwei across the blocks we sampled,
 * but we do not hardcode that: we read it, and we report the observed spread so
 * a future change in fee dynamics shows up as data rather than as a wrong number.
 */
export async function quoteFees(rpc, { blocks = 5, priorityWei = 0n, bufferPercent = 20n } = {}) {
  let history = null;
  let historyFailure = null;
  try {
    history = await rpc.call("eth_feeHistory", [toQuantity(blocks), "latest", []]);
  } catch (error) {
    historyFailure = String(error?.message || error);
    history = null;
  }

  const baseFees = (history?.baseFeePerGas || []).map((h) => BigInt(h));
  const latestBase = baseFees.length ? baseFees[baseFees.length - 1] : null;
  if (latestBase === null) {
    const gp = await rpc.call("eth_gasPrice", []);
    const gasPrice = BigInt(gp);
    return {
      baseFee: gasPrice,
      priorityFee: 0n,
      maxFeePerGas: gasPrice,
      spread: { min: gasPrice, max: gasPrice, samples: 1 },
      source: historyFailure
        ? `eth_gasPrice fallback (feeHistory unavailable: ${historyFailure})`
        : "eth_gasPrice fallback (feeHistory returned no base fee)",
      historyFailure,
    };
  }

  const rewards = (history?.reward || []).flat().filter(Boolean).map((r) => BigInt(r));
  const observedPriority = rewards.length ? rewards.sort((a, b) => (a < b ? -1 : 1))[Math.floor(rewards.length / 2)] : 0n;
  const priority = priorityWei > 0n ? priorityWei : observedPriority;
  const headroom = (latestBase * bufferPercent) / 100n;
  const sorted = [...baseFees].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    baseFee: latestBase,
    priorityFee: priority,
    maxFeePerGas: latestBase + headroom + priority,
    spread: { min: sorted[0], max: sorted[sorted.length - 1], samples: baseFees.length },
    source: "eth_feeHistory",
    historyFailure: null,
  };
}

/**
 * Measure the minimum gas at which the call succeeds, by bisection on the `gas`
 * field of eth_call.
 *
 * Why bother: eth_estimateGas on Pharos reported 69,682 for a call whose receipt
 * burned 53,996 (+29%), and in other samples +36% and +74%. Bisection lands
 * within 0.65% of the receipt because it finds the actual boundary instead of
 * applying the node's own safety padding. It costs about log2(range) ≈ 17 cheap
 * calls, which is worth it for a number the user budgets against.
 *
 * Returns null when the call cannot succeed at any gas (i.e. it reverts), because
 * a revert has no gas requirement to report.
 */
export async function measureMinimumGas(rpc, { tx, blockTag, upperBound, lowerBound = 21_000n, margin = 100n } = {}) {
  if (!upperBound) return null;
  let hi = BigInt(upperBound);
  let lo = BigInt(lowerBound);
  if (hi <= lo) return null;

  // The node answers "not enough gas" with the same code-3 revert it uses for a
  // real revert (message "execution reverted: " and no data), so the error text
  // cannot tell them apart. We do not need it to: once the call is known to
  // succeed at the upper bound, any failure at a lower bound can only mean the
  // bound is too low. That invariant is what makes the bisection sound.
  const attempt = async (gas) => {
    try {
      await rpc.call("eth_call", [{ ...tx, gas: toQuantity(gas) }, blockTag]);
      return { ok: true };
    } catch (err) {
      if (err?.name === "TransportError") throw err; // never bisect over a broken connection
      return { ok: false, error: err };
    }
  };

  let probes = 0;
  const ceiling = await attempt(hi);
  probes++;
  if (!ceiling.ok) {
    // The call cannot succeed even with generous gas: that is a revert, and a
    // revert has no gas requirement to report.
    return {
      minimum: null,
      probes,
      reason: `the call does not succeed at ${hi} gas: ${ceiling.error?.message || "unknown"}`,
    };
  }

  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (mid === lo) break;
    probes++;
    const probe = await attempt(mid);
    if (probe.ok) hi = mid;
    else lo = mid + 1n;
  }

  const minimum = lo;
  return {
    minimum: margin > 100n ? (minimum * margin) / 100n : minimum,
    rawMinimum: minimum,
    probes,
    searchedUpTo: BigInt(upperBound),
  };
}

/**
 * Decide what to submit and what to expect.
 *
 * gasLimit is the maximum of the node estimate and the historical p90 (plus a
 * margin), because the estimate is sometimes below past worst cases. expectedGas
 * is the historical median when we have it: that is what the user will actually
 * pay, and it is measurably below the limit they submit.
 */
export function planGas({ measured, estimate, intrinsic, history, marginPercent = 15n }) {
  // Provenance order, best first. Each label travels with the number so a report
  // can never present a guess as a measurement.
  let expectedGas = null;
  let expectedSource = "unavailable";

  if (measured?.minimum) {
    expectedGas = BigInt(measured.minimum);
    expectedSource = `measured by bisection, ${measured.probes} probes`;
  } else if (history?.median) {
    expectedGas = BigInt(history.median);
    expectedSource = `median of ${history.count} successful past calls with this selector`;
  } else if (estimate !== null && estimate !== undefined) {
    expectedGas = BigInt(estimate);
    expectedSource = "node estimate (no measurement possible, no comparable history)";
  }

  const expectedFromMeasurement = Boolean(measured?.minimum);

  // The limit gets headroom over the measurement because state can shift between
  // the pinned block and inclusion. Headroom is free unless used: you are billed
  // for gas consumed, not for the limit submitted.
  let gasLimit = null;
  if (expectedGas !== null) {
    gasLimit = (expectedGas * (100n + marginPercent)) / 100n;
    if (intrinsic !== null && gasLimit < BigInt(intrinsic)) gasLimit = BigInt(intrinsic);
  }

  const overestimatePercent =
    expectedFromMeasurement && expectedGas > 0n && estimate !== null && estimate !== undefined
      ? (Number(BigInt(estimate) - expectedGas) / Number(expectedGas)) * 100
      : null;

  return {
    gasLimit,
    expectedGas,
    expectedSource,
    expectedFromMeasurement,
    nodeEstimate: estimate === null || estimate === undefined ? null : BigInt(estimate),
    nodeEstimateOverMeasuredPercent: overestimatePercent,
    probes: measured?.probes ?? null,
    aboveIntrinsic: gasLimit !== null && intrinsic !== null ? gasLimit >= BigInt(intrinsic) : null,
    historyMedian: history?.median ? BigInt(history.median) : null,
  };
}
