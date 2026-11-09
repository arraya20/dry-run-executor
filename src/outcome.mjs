// Expected outcome: balances and allowances before and after the transaction.
//
// "Before" is read from the node at the pinned block. "After" is NOT observed:
// this node has no prestateTracer, no eth_simulateV1, and callTracer drops logs,
// so the only way to name an "after" figure is to apply the calldata-derived
// change to the "before" figure. Every row says so (`observed: false`), and a
// row whose arithmetic does not hold reports `after: null` with the reason
// instead of a made-up number.

import { selector } from "./keccak.mjs";
import { padWord, wordToBigInt, formatUnits, fromQuantity } from "./hex.mjs";

const BALANCE_OF = selector("balanceOf(address)");
const ALLOWANCE = selector("allowance(address,address)");

const NATIVE = { symbol: "PROS", decimals: 18 };

async function readToken(rpc, blockTag, token, data) {
  try {
    const hex = await rpc.call("eth_call", [{ to: token, data }, blockTag]);
    if (!hex || hex === "0x") return { value: null, error: "the token returned no data" };
    return { value: wordToBigInt(hex), error: null };
  } catch (err) {
    return { value: null, error: String(err?.message || err) };
  }
}

async function readNative(rpc, blockTag, address) {
  try {
    return { value: fromQuantity(await rpc.call("eth_getBalance", [address, blockTag])), error: null };
  } catch (err) {
    return { value: null, error: String(err?.message || err) };
  }
}

const signed = (value, decimals) => `${value > 0n ? "+" : ""}${formatUnits(value, decimals)}`;

/**
 * One before/after row. `change` is a signed delta, or the new absolute value
 * when `absolute` is set (approve overwrites an allowance rather than adding).
 */
function makeRow({ kind, account, asset, spender = null, decimals, read, change, absolute = false, basis }) {
  const row = {
    kind,
    account,
    asset,
    spender,
    observed: false,
    basis,
    before: null,
    after: null,
    change: null,
    beforeFormatted: null,
    afterFormatted: null,
    changeFormatted: null,
    note: null,
  };

  const fmt = (v) => (decimals === null || decimals === undefined ? null : formatUnits(v, decimals));

  if (read.value === null) {
    row.note = `current value could not be read: ${read.error}`;
    if (!absolute) {
      row.change = change.toString();
      row.changeFormatted = decimals === null || decimals === undefined ? null : signed(change, decimals);
    }
    return row;
  }

  const before = read.value;
  const after = absolute ? change : before + change;
  const delta = after - before;

  row.before = before.toString();
  row.beforeFormatted = fmt(before);
  row.change = delta.toString();
  row.changeFormatted = decimals === null || decimals === undefined ? null : signed(delta, decimals);

  if (after < 0n) {
    row.note =
      "applying the derived change would take this below zero, so no 'after' figure is given; the derived change and the chain state disagree";
    return row;
  }
  row.after = after.toString();
  row.afterFormatted = fmt(after);
  return row;
}

/**
 * @param {object} p
 * @param {object} p.rpc            JSON-RPC client
 * @param {string} p.blockTag       pinned block, as a quantity
 * @param {bigint|number} p.block   pinned block number, for labels
 * @param {object} p.req            validated request
 * @param {object} p.intent         decoded intent (with deltas)
 * @param {object|null} p.token     token context, when the call is a token op
 * @param {object} p.execution      result of the eth_call
 * @param {bigint|null} p.expectedCostWei  expected gas cost, charged to the sender
 * @param {bigint} p.senderBalance  sender native balance at the pinned block
 */
export async function buildOutcome({ rpc, blockTag, block, req, intent, token, execution, expectedCostWei, senderBalance }) {
  const basis = `derived from calldata and chain state at block ${block}`;

  if (execution.status !== "succeeds") {
    return {
      status: "not-predicted",
      basis: null,
      reason:
        "the call does not succeed, so there is no state change to predict; a failed call leaves balances as they are apart from any gas consumed",
      rows: [],
      notes: [],
    };
  }

  const notes = [];

  // --- native balance changes -------------------------------------------
  const native = new Map();
  const addNative = (account, amount) => native.set(account, (native.get(account) ?? 0n) + amount);

  for (const d of intent.deltas || []) {
    if (d.token === null || d.token === undefined) addNative(d.account, BigInt(d.change));
  }
  if (intent.kind !== "native-transfer" && req.value > 0n) {
    addNative(req.from, -req.value);
    addNative(req.to, req.value);
  }
  if (intent.kind === "wrapped-native-withdraw" && intent.amountWei) {
    addNative(req.from, BigInt(intent.amountWei));
  }
  if (expectedCostWei !== null && expectedCostWei !== undefined) {
    addNative(req.from, -expectedCostWei);
  } else {
    addNative(req.from, 0n);
    notes.push("the sender's gas cost is not included because no gas figure could be established");
  }

  // --- token balance and allowance changes -------------------------------
  const tokenAddress = req.to;
  const tokenChanges = new Map();
  const allowances = [];
  let skippedOwnership = false;

  for (const d of intent.deltas || []) {
    if (!d.token) continue;
    if (d.field === "balance") {
      tokenChanges.set(d.account, (tokenChanges.get(d.account) ?? 0n) + BigInt(d.change));
    } else if (d.field === "allowance") {
      allowances.push(d);
    } else if (d.field === "ownerOf") {
      skippedOwnership = true;
    }
  }
  if (skippedOwnership) {
    notes.push("NFT ownership is not read back; see the derived changes list for the transfer");
  }

  const decimals = token?.decimals ?? null;
  const asset = token?.symbol || tokenAddress;
  if ((tokenChanges.size || allowances.length) && decimals === null) {
    notes.push("token decimals could not be read, so token amounts are shown in raw units only");
  }

  // --- reads, all in parallel against the same pinned block --------------
  const nativeJobs = [...native.entries()].map(async ([account, change]) => ({
    account,
    change,
    read: account === req.from ? { value: senderBalance, error: null } : await readNative(rpc, blockTag, account),
  }));

  const tokenJobs = [...tokenChanges.entries()].map(async ([account, change]) => ({
    account,
    change,
    read: await readToken(rpc, blockTag, tokenAddress, BALANCE_OF + padWord(account)),
  }));

  const allowanceJobs = allowances.map(async (d) => ({
    d,
    change: BigInt(d.change),
    read: await readToken(rpc, blockTag, tokenAddress, ALLOWANCE + padWord(d.account) + padWord(d.spender)),
  }));

  const [nativeReads, tokenReads, allowanceReads] = await Promise.all([
    Promise.all(nativeJobs),
    Promise.all(tokenJobs),
    Promise.all(allowanceJobs),
  ]);

  const rows = [
    ...nativeReads.map((r) =>
      makeRow({
        kind: "native",
        account: r.account,
        asset: NATIVE.symbol,
        decimals: NATIVE.decimals,
        read: r.read,
        change: r.change,
        basis: r.account === req.from ? `${basis}; includes value and expected gas cost` : basis,
      }),
    ),
    ...tokenReads.map((r) =>
      makeRow({ kind: "token-balance", account: r.account, asset, decimals, read: r.read, change: r.change, basis }),
    ),
    ...allowanceReads.map((r) =>
      makeRow({
        kind: "allowance",
        account: r.d.account,
        spender: r.d.spender,
        asset,
        decimals,
        read: r.read,
        change: r.change,
        absolute: Boolean(r.d.absolute),
        basis,
      }),
    ),
  ];

  return { status: "predicted", basis, observed: false, rows, notes };
}
