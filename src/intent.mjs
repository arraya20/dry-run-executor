// What is this calldata trying to do?
//
// We decode the handful of shapes that cover most real traffic so the report can
// state intent in words and, where the semantics are unambiguous, the balance
// change the call implies.
//
// The distinction that matters for honesty: the EFFECT is derived from calldata,
// not observed on-chain. This node exposes no post-state trace (prestateTracer is
// unsupported, callTracer drops logs, structLogs drops memory), so a token that
// takes a transfer fee would break the arithmetic below. Every derived delta is
// therefore labelled derived, and the report says plainly that post-state was
// not measured.

import { selector } from "./keccak.mjs";
import { words, wordToBigInt, wordToAddress, strip0x } from "./hex.mjs";

const TRANSFER = selector("transfer(address,uint256)");
const TRANSFER_FROM = selector("transferFrom(address,address,uint256)");
const APPROVE = selector("approve(address,uint256)");
const INCREASE_ALLOWANCE = selector("increaseAllowance(address,uint256)");
const DECREASE_ALLOWANCE = selector("decreaseAllowance(address,uint256)");
const SET_APPROVAL_FOR_ALL = selector("setApprovalForAll(address,bool)");
const SAFE_TRANSFER_FROM = selector("safeTransferFrom(address,address,uint256)");
const SAFE_TRANSFER_FROM_DATA = selector("safeTransferFrom(address,address,uint256,bytes)");
const MULTICALL = selector("multicall(bytes[])");
const DEPOSIT = selector("deposit()");
const WITHDRAW = selector("withdraw(uint256)");

/**
 * @returns {{kind:string, describe:string, deltas:Array, tokenOp:boolean}|null}
 */
export function decodeIntent({ from, to, data, value = 0n }) {
  if (!data || strip0x(data).length < 8) {
    if (value > 0n) {
      return {
        kind: "native-transfer",
        describe: `send ${value} wei of native value to ${to}`,
        amountWei: value.toString(),
        deltas: [
          { account: from, token: null, field: "native balance", change: `-${value}` },
          { account: to, token: null, field: "native balance", change: `${value}` },
        ],
        tokenOp: false,
      };
    }
    return { kind: "empty-call", describe: "call with no calldata", deltas: [], tokenOp: false };
  }

  const sel = data.slice(0, 10).toLowerCase();
  const args = words("0x" + strip0x(data).slice(8));

  if (sel === TRANSFER) {
    const recipient = wordToAddress(args[0] || "");
    const amount = wordToBigInt(args[1] || "0");
    return {
      kind: "erc20-transfer",
      describe: `transfer ${amount} of the token at ${to} to ${recipient}`,
      amountWei: amount.toString(),
      tokenOp: true,
      selfTransfer: recipient.toLowerCase() === from.toLowerCase(),
      deltas: [
        { account: from, token: to, field: "balance", change: `-${amount}`, note: "derived from calldata" },
        { account: recipient, token: to, field: "balance", change: `${amount}`, note: "derived from calldata" },
      ],
    };
  }

  if (sel === TRANSFER_FROM) {
    const owner = wordToAddress(args[0] || "");
    const recipient = wordToAddress(args[1] || "");
    const amount = wordToBigInt(args[2] || "0");
    return {
      kind: "erc20-transferFrom",
      describe: `move ${amount} of the token at ${to} from ${owner} to ${recipient}, spending your allowance`,
      amountWei: amount.toString(),
      tokenOp: true,
      deltas: [
        { account: owner, token: to, field: "balance", change: `-${amount}`, note: "derived from calldata" },
        { account: recipient, token: to, field: "balance", change: `${amount}`, note: "derived from calldata" },
        { account: owner, token: to, field: "allowance", spender: from, change: `-${amount}`, note: "derived, assuming the allowance is decremented" },
      ],
    };
  }

  if (sel === APPROVE) {
    const spender = wordToAddress(args[0] || "");
    const amount = wordToBigInt(args[1] || "0");
    const unlimited = amount === (1n << 256n) - 1n;
    return {
      kind: "erc20-approve",
      describe:
        amount === 0n
          ? `revoke the allowance of ${spender} for the token at ${to}`
          : `allow ${spender} to spend ${unlimited ? "an UNLIMITED amount" : amount.toString()} of the token at ${to}`,
      amountWei: amount.toString(),
      tokenOp: true,
      scary: unlimited,
      deltas: [
        { account: from, token: to, field: "allowance", spender, change: `${amount}`, absolute: true, note: "derived from calldata" },
      ],
    };
  }

  if (sel === INCREASE_ALLOWANCE || sel === DECREASE_ALLOWANCE) {
    const spender = wordToAddress(args[0] || "");
    const amount = wordToBigInt(args[1] || "0");
    const sign = sel === INCREASE_ALLOWANCE ? "+" : "-";
    return {
      kind: "erc20-allowance-change",
      describe: `${sign === "+" ? "increase" : "decrease"} the allowance of ${spender} for the token at ${to} by ${amount}`,
      amountWei: amount.toString(),
      tokenOp: true,
      deltas: [
        { account: from, token: to, field: "allowance", spender, change: `${sign}${amount}`, note: "derived from calldata" },
      ],
    };
  }

  if (sel === SET_APPROVAL_FOR_ALL) {
    const operator = wordToAddress(args[0] || "");
    const approved = wordToBigInt(args[1] || "0") !== 0n;
    return {
      kind: "erc721-setApprovalForAll",
      describe: `${approved ? "grant" : "revoke"} ${operator} control over ALL of your tokens in the collection at ${to}`,
      tokenOp: true,
      scary: approved,
      deltas: [],
    };
  }

  if (sel === SAFE_TRANSFER_FROM || sel === SAFE_TRANSFER_FROM_DATA) {
    const owner = wordToAddress(args[0] || "");
    const recipient = wordToAddress(args[1] || "");
    const tokenId = wordToBigInt(args[2] || "0");
    return {
      kind: "erc721-safeTransferFrom",
      describe: `transfer NFT #${tokenId} of ${to} from ${owner} to ${recipient}`,
      tokenOp: true,
      deltas: [
        { account: owner, token: to, field: "ownerOf", tokenId: tokenId.toString(), change: recipient, note: "derived from calldata" },
      ],
    };
  }

  if (sel === MULTICALL) {
    return {
      kind: "multicall",
      describe: `batched call through ${to} — the individual operations are not unpacked here`,
      tokenOp: false,
      deltas: [],
      warning: "a multicall can hide any of the operations above; read the sub-calls before signing",
    };
  }

  if (sel === DEPOSIT) {
    return {
      kind: "wrapped-native-deposit",
      describe: `wrap ${value} wei of native value into the token at ${to}`,
      tokenOp: true,
      deltas: [
        { account: from, token: to, field: "balance", change: `${value}`, note: "derived, assumes a 1:1 wrap" },
      ],
    };
  }

  if (sel === WITHDRAW) {
    const amount = wordToBigInt(args[0] || "0");
    return {
      kind: "wrapped-native-withdraw",
      describe: `unwrap ${amount} wei from the token at ${to}`,
      tokenOp: true,
      deltas: [
        { account: from, token: to, field: "balance", change: `-${amount}`, note: "derived, assumes a 1:1 unwrap" },
      ],
    };
  }

  return {
    kind: "unknown",
    selector: sel,
    describe: `call ${sel} on ${to} — calldata shape is not one this tool recognises`,
    tokenOp: false,
    deltas: [],
  };
}
