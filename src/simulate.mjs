// The dry run itself.
//
// Contract with the caller, and it is deliberately narrow: you supply a
// transaction, you get back measurements. You cannot supply a verdict. Any field
// that looks like a conclusion (mockRevert, willSucceed, gasUsed, status…) is
// rejected with HTTP 400 naming the offending field, because a simulator that
// accepts the answer as input is not a simulator.

import { createRpc, assertChain, RpcError } from "./rpc.mjs";
import { decodeRevert } from "./revert.mjs";
import { decodeIntent } from "./intent.mjs";
import {
  intrinsicGas,
  sampleHistoricalGas,
  quoteFees,
  planGas,
  measureMinimumGas,
  selectorOf,
} from "./gas.mjs";
import {
  normaliseAddress,
  isAddress,
  formatUnits,
  toQuantity,
  fromQuantity,
  isHexData,
  padWord,
  wordToBigInt,
  strip0x,
} from "./hex.mjs";
import { selector } from "./keccak.mjs";

export const PHAROS = {
  chainId: 1672,
  rpc: "https://rpc.pharos.xyz",
  explorer: "https://pharos.socialscan.io",
  nativeSymbol: "PROS",
  nativeDecimals: 18,
};

// Fields a caller may send. Everything else is refused.
const ALLOWED_FIELDS = new Set(["from", "to", "data", "value", "blockTag", "gas", "chainId"]);

// Field names that would turn this from a measurement into an assertion.
const VERDICT_PATTERNS = [
  /^(mock|fake|assume|pretend|simulate)/i,
  /^(success|willSucceed|succeeded|status|ok|passed)$/i,
  /revert/i,
  /^(gasUsed|estimatedGas|predictedGas|gasEstimate|cost|fee)$/i,
  /^(verdict|risk|score|rating|safe|dangerous|blocked)$/i,
];

const ERC20 = {
  symbol: selector("symbol()"),
  decimals: selector("decimals()"),
  balanceOf: selector("balanceOf(address)"),
  allowance: selector("allowance(address,address)"),
  totalSupply: selector("totalSupply()"),
};

export class RequestError extends Error {
  constructor(message, { field, status = 400 } = {}) {
    super(message);
    this.name = "RequestError";
    this.field = field;
    this.status = status;
  }
}

/**
 * Address parsing that keeps the failure typed. normaliseAddress throws a plain
 * Error, which the HTTP layer would report as a 500; a bad address is the
 * caller's mistake and must come back as a 400 naming the field.
 */
function asAddress(value, field) {
  if (!isAddress(value)) {
    throw new RequestError(`${field} must be a 0x-prefixed 20-byte address`, { field });
  }
  return normaliseAddress(value, field);
}

/** Validate and normalise the incoming request. Throws RequestError on anything odd. */
export function validateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError("request body must be a JSON object");
  }

  for (const key of Object.keys(body)) {
    if (ALLOWED_FIELDS.has(key)) continue;
    if (VERDICT_PATTERNS.some((re) => re.test(key))) {
      throw new RequestError(
        `field "${key}" is a conclusion, not an input. Supply the raw transaction (from, to, data, value) and this tool will measure the outcome itself.`,
        { field: key },
      );
    }
    throw new RequestError(`unknown field "${key}"; permitted fields are ${[...ALLOWED_FIELDS].join(", ")}`, { field: key });
  }

  if (body.from === undefined) throw new RequestError("from is required: a dry run has a sender", { field: "from" });
  if (body.to === undefined) throw new RequestError("to is required", { field: "to" });

  const from = asAddress(body.from, "from");
  const to = asAddress(body.to, "to");

  const data = body.data === undefined ? "0x" : body.data;
  if (!isHexData(data)) throw new RequestError("data must be 0x-prefixed hex bytes", { field: "data" });

  let value = 0n;
  if (body.value !== undefined) {
    try {
      // BigInt accepts "0x…" and decimal and rejects "1.5", which is the
      // behaviour we want; wei has no fractional part.
      value = BigInt(body.value);
    } catch {
      throw new RequestError("value must be a decimal string or 0x-quantity in wei", { field: "value" });
    }
    if (value < 0n) throw new RequestError("value cannot be negative", { field: "value" });
  }

  let gas = null;
  if (body.gas !== undefined) {
    try {
      gas = BigInt(body.gas);
    } catch {
      throw new RequestError("gas must be a number", { field: "gas" });
    }
    if (gas < 21000n) throw new RequestError("gas below the 21000 intrinsic floor", { field: "gas" });
  }

  return { from, to, data, value, gas, blockTag: body.blockTag, chainId: body.chainId };
}

/** Classify an eth_call / eth_estimateGas failure without flattening it. */
function classifyFailure(err) {
  if (err instanceof RpcError) {
    const msg = err.message || "";
    if (err.code === -32029 || /not have enough funds/i.test(msg)) {
      return { status: "insufficient-funds", detail: msg };
    }
    if (err.code === 3 || /revert/i.test(msg)) {
      return { status: "reverts", revert: decodeRevert(err.data || "0x") };
    }
    return { status: "node-error", detail: msg, code: err.code };
  }
  return { status: "transport-error", detail: String(err?.message || err) };
}

/** Read a uint/string/bool getter, returning null instead of throwing when absent. */
async function tryCall(rpc, blockTag, to, data) {
  try {
    const out = await rpc.call("eth_call", [{ to, data }, blockTag]);
    return out;
  } catch {
    return null;
  }
}

function decodeStringResult(hex) {
  if (!hex || hex === "0x") return null;
  const body = strip0x(hex);
  if (body.length === 64) {
    // bytes32-style symbol (older tokens)
    const bytes = body.replace(/(00)+$/, "");
    try {
      return new TextDecoder().decode(new Uint8Array(bytes.match(/../g)?.map((b) => parseInt(b, 16)) || []));
    } catch {
      return null;
    }
  }
  if (body.length >= 128) {
    const len = Number(BigInt("0x" + body.slice(64, 128)));
    const payload = body.slice(128, 128 + len * 2);
    try {
      return new TextDecoder().decode(new Uint8Array(payload.match(/../g)?.map((b) => parseInt(b, 16)) || []));
    } catch {
      return null;
    }
  }
  return null;
}

async function readTokenContext(rpc, blockTag, token, holder, spender) {
  const [symbolHex, decimalsHex, balanceHex, allowanceHex] = await Promise.all([
    tryCall(rpc, blockTag, token, ERC20.symbol),
    tryCall(rpc, blockTag, token, ERC20.decimals),
    tryCall(rpc, blockTag, token, ERC20.balanceOf + padWord(holder)),
    spender
      ? tryCall(rpc, blockTag, token, ERC20.allowance + padWord(holder) + padWord(spender))
      : Promise.resolve(null),
  ]);

  const decimals = decimalsHex ? Number(wordToBigInt(decimalsHex)) : null;
  const balance = balanceHex ? wordToBigInt(balanceHex) : null;
  return {
    symbol: decodeStringResult(symbolHex),
    decimals,
    balanceOfHolder: balance === null ? null : balance.toString(),
    // Human-readable form so a report never needs the reader to do decimal shifts.
    balanceFormatted: balance !== null && decimals !== null ? formatTokenAmount(balance, decimals) : null,
    allowance: allowanceHex ? wordToBigInt(allowanceHex).toString() : null,
    standard: balanceHex !== null,
  };
}

/**
 * Run the dry run.
 * @param {object} input raw request (already parsed JSON)
 * @param {object} deps { rpc?, fetchImpl?, url?, chainId?, lookbackBlocks?, skipHistory? }
 */
export async function dryRun(input, deps = {}) {
  const req = validateRequest(input);
  const chainId = deps.chainId ?? PHAROS.chainId;
  const rpc = deps.rpc || createRpc({ url: deps.url || PHAROS.rpc, fetchImpl: deps.fetchImpl });

  const actualChain = await assertChain(rpc, chainId);

  // Pin one block so every read describes the same world. Without this, the
  // balance check and the call could disagree by a block and the report would
  // silently mix two states.
  const headQuantity = await rpc.call("eth_blockNumber", []);
  const head = fromQuantity(headQuantity);
  let blockTag;
  if (req.blockTag === undefined || req.blockTag === null || req.blockTag === "latest") {
    blockTag = toQuantity(head);
  } else {
    const wanted = BigInt(req.blockTag);
    if (wanted > head) throw new RequestError(`blockTag ${wanted} is ahead of head ${head}`, { field: "blockTag" });
    blockTag = toQuantity(wanted);
  }
  const pinnedBlock = fromQuantity(blockTag);

  // --- execution: does it revert, and if so why
  const callTx = { from: req.from, to: req.to, data: req.data };
  if (req.value > 0n) callTx.value = toQuantity(req.value);
  if (req.gas) callTx.gas = toQuantity(req.gas);

  let execution;
  let returnData = null;
  try {
    returnData = await rpc.call("eth_call", [callTx, blockTag]);
    execution = { status: "succeeds", returnData, revert: null };
  } catch (err) {
    execution = classifyFailure(err);
  }

  const selectorUsed = selectorOf(req.data);
  const intent = decodeIntent({ from: req.from, to: req.to, data: req.data, value: req.value });

  // --- gas: estimate as a ceiling, history as the forecast
  const intrinsic = intrinsicGas({ to: req.to, data: req.data });
  let estimate = null;
  let estimateFailure = null;
  let measured = null;
  let measurementNote = null;

  if (execution.status === "succeeds") {
    try {
      estimate = fromQuantity(await rpc.call("eth_estimateGas", [callTx, blockTag]));
    } catch (err) {
      estimateFailure = classifyFailure(err);
    }

    // Measure rather than trust: bisect the gas field until the call stops
    // succeeding. Bounded so a pathological call cannot spin forever.
    const upper = estimate !== null ? (estimate * 150n) / 100n : 30_000_000n;
    try {
      measured = await measureMinimumGas(rpc, { tx: callTx, blockTag, upperBound: upper, lowerBound: intrinsic });
      if (!measured?.minimum) {
        measurementNote = measured?.reason || "the call did not succeed at the gas bound tried, so no measured figure is reported";
      }
    } catch (err) {
      measurementNote = `bisection aborted: ${err?.message || err}`;
    }
  } else {
    estimateFailure = { status: execution.status, detail: "estimateGas is skipped when the call does not succeed; a revert has no gas requirement" };
    measurementNote = "not attempted: the call reverts, so there is no gas figure that would make it succeed";
  }

  let history = { summary: null, samples: [] };
  if (!deps.skipHistory && selectorUsed) {
    try {
      history = await sampleHistoricalGas(rpc, {
        to: req.to,
        selector: selectorUsed,
        lookbackBlocks: deps.lookbackBlocks ?? 4_000,
      });
    } catch (err) {
      history = { summary: null, samples: [], note: `history unavailable: ${err?.message || err}` };
    }
  }

  const gasPlan = planGas({ measured, estimate, intrinsic, history: history.summary });
  const fees = await quoteFees(rpc);

  // --- account and target state at the pinned block
  const [balanceHex, nonceHex, targetCode, fromCode] = await Promise.all([
    rpc.call("eth_getBalance", [req.from, blockTag]),
    rpc.call("eth_getTransactionCount", [req.from, blockTag]),
    rpc.call("eth_getCode", [req.to, blockTag]),
    rpc.call("eth_getCode", [req.from, blockTag]),
  ]);

  const balance = fromQuantity(balanceHex);
  const nonce = fromQuantity(nonceHex);
  const targetIsContract = targetCode && targetCode !== "0x";
  const senderIsContract = fromCode && fromCode !== "0x";

  // --- affordability. This is the check eth_estimateGas does NOT do for
  // zero-value calls: we measured a sender with no native balance getting a
  // clean estimate.
  const limitCostWei = gasPlan.gasLimit !== null ? gasPlan.gasLimit * fees.maxFeePerGas : null;
  const expectedCostWei = gasPlan.expectedGas !== null ? gasPlan.expectedGas * fees.maxFeePerGas : null;
  const requiredWei = (limitCostWei ?? 0n) + req.value;
  const sufficient = balance >= requiredWei;
  const shortfall = sufficient ? 0n : requiredWei - balance;

  // --- token context, only when the call is a token operation
  let token = null;
  if (intent.tokenOp) {
    // transferFrom's first argument is the owner whose balance moves; for every
    // other token op it is the sender.
    const holderAddr =
      intent.kind === "erc20-transferFrom" ? "0x" + strip0x(req.data).slice(8 + 24, 8 + 64) : req.from;
    token = await readTokenContext(rpc, blockTag, req.to, holderAddr, req.from);
    token.holder = holderAddr;
  }

  // Decimals are only known once the token has been read, so the human-readable
  // amount is attached here rather than inside the calldata decoder.
  if (token && intent.amountWei && token.decimals !== null) {
    intent.amountHuman = `${formatTokenAmount(BigInt(intent.amountWei), token.decimals)} ${token.symbol || "tokens"}`;
  }
  if (intent.selfTransfer) {
    intent.warning = "the recipient is the sender, so the two balance changes cancel out";
  }

  // --- what blocks a send
  const blocking = [];
  if (execution.status === "reverts") {
    blocking.push(`the call reverts at block ${pinnedBlock}: ${execution.revert.summary}`);
  }
  if (execution.status === "insufficient-funds") {
    blocking.push(`the sender cannot cover value + gas: ${execution.detail}`);
  }
  if (execution.status === "node-error" || execution.status === "transport-error") {
    blocking.push(`the node did not answer the call: ${execution.detail}`);
  }
  if (!sufficient) {
    blocking.push(`balance ${balance} wei is below the ${requiredWei} wei needed for value + maximum gas cost`);
  }
  if (gasPlan.aboveIntrinsic === false) {
    blocking.push(`gas limit ${gasPlan.gasLimit} is below the ${intrinsic} intrinsic floor`);
  }
  if (gasPlan.gasLimit === null) {
    blocking.push("no gas limit could be derived, so this transaction is not submittable as-is");
  }

  // Four outcomes that must not be collapsed into one. A revert is the chain
  // refusing; insufficient funds is the sender being unable to pay; a node that
  // did not answer measured nothing at all and must never read as "will revert".
  const verdict = {
    reverts: "WILL-REVERT",
    "insufficient-funds": "INSUFFICIENT-FUNDS",
    succeeds: !sufficient ? "INSUFFICIENT-FUNDS" : gasPlan.gasLimit === null ? "INCOMPLETE" : "READY",
  }[execution.status] || "INCOMPLETE";

  // --- what this tool could not see. Stated, never omitted.
  const notMeasured = [
    "post-state balances and allowances: this node rejects prestateTracer, drops logs from callTracer, omits memory from structLogs, and has no eth_simulateV1 — so the delta list above is derived from calldata, not observed",
    "internal calls and value moved inside the target contract: no callTracer log data and truncated structLogs on larger calls",
    "token transfer fees or rebasing: a fee-on-transfer token would make the derived deltas wrong, and this node cannot confirm the received amount",
    "whether the target is a proxy and what implementation it delegates to: eth_getCode returns the proxy bytecode only",
  ];
  if (!selectorUsed) notMeasured.push("gas history: a call with no selector has no comparable past transactions");

  // --- a transaction object the caller can sign. Never signed here.
  const submit = {
    chainId: actualChain,
    from: req.from,
    to: req.to,
    data: req.data,
    value: toQuantity(req.value),
    nonce: Number(nonce),
    gas: gasPlan.gasLimit !== null ? Number(gasPlan.gasLimit) : null,
    maxFeePerGas: toQuantity(fees.maxFeePerGas),
    maxPriorityFeePerGas: toQuantity(fees.priorityFee),
    type: 2,
  };

  return {
    chain: { id: actualChain, name: "Pharos Pacific", block: Number(pinnedBlock) },
    checkedAt: new Date().toISOString(),
    request: { from: req.from, to: req.to, data: req.data, value: req.value.toString(), gas: req.gas?.toString() ?? null },
    intent,
    verdict,
    blocking,
    execution,
    gas: {
      intrinsic: intrinsic.toString(),
      expected: gasPlan.expectedGas?.toString() ?? null,
      expectedSource: gasPlan.expectedSource,
      expectedIsMeasured: gasPlan.expectedFromMeasurement,
      measuredProbes: gasPlan.probes,
      limit: gasPlan.gasLimit?.toString() ?? null,
      nodeEstimate: gasPlan.nodeEstimate?.toString() ?? null,
      nodeEstimateOverMeasuredPercent: gasPlan.nodeEstimateOverMeasuredPercent,
      estimateFailure,
      measurementNote,
      history: history.summary
        ? {
            count: history.summary.count,
            median: history.summary.median.toString(),
            p90: history.summary.p90.toString(),
            min: history.summary.min.toString(),
            max: history.summary.max.toString(),
            window: history.window,
          }
        : null,
      historyNote: history.note ?? null,
    },
    fees: {
      baseFee: fees.baseFee.toString(),
      priorityFee: fees.priorityFee.toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(),
      source: fees.source,
      baseFeeSpread: { min: fees.spread.min.toString(), max: fees.spread.max.toString(), samples: fees.spread.samples },
    },
    cost: {
      maxWei: limitCostWei?.toString() ?? null,
      expectedWei: expectedCostWei?.toString() ?? null,
      maxPROS: limitCostWei !== null ? formatPROS(limitCostWei) : null,
      expectedPROS: expectedCostWei !== null ? formatPROS(expectedCostWei) : null,
    },
    account: { address: req.from, balanceWei: balance.toString(), balancePROS: formatPROS(balance), nonce: nonce.toString(), isContract: Boolean(senderIsContract) },
    target: { address: req.to, isContract: Boolean(targetIsContract), codeSize: targetCode ? (targetCode.length - 2) / 2 : 0 },
    funding: {
      requiredWei: requiredWei.toString(),
      requiredPROS: formatPROS(requiredWei),
      balanceWei: balance.toString(),
      sufficient,
      shortfallWei: shortfall.toString(),
      shortfallPROS: formatPROS(shortfall),
    },
    token,
    notMeasured,
    submit,
  };
}

const formatTokenAmount = (value, decimals) => formatUnits(value, decimals);
const formatPROS = (wei) => formatUnits(wei, 18);

export { PHAROS as defaults, formatPROS, formatTokenAmount };
