// Turn raw revert data into something a human can act on.
//
// Solidity encodes failures three ways and they are easy to confuse:
//   Error(string)     0x08c379a0 + abi-encoded string   require(cond, "...")
//   Panic(uint256)    0x4e487b71 + code                 checked arithmetic, assert
//   custom error      4-byte selector + arguments       error NotOwner()
//
// Selectors here are COMPUTED from the signature with our own keccak, never
// typed in as constants. A hardcoded table silently rots; a computed one cannot
// disagree with the signature next to it. test/unit.test.mjs checks the
// computed selectors against values observed in real reverts on Pharos.

import { selector } from "./keccak.mjs";
import { words, wordToBigInt, wordToAddress, strip0x } from "./hex.mjs";

const ERROR_STRING = selector("Error(string)");
const PANIC = selector("Panic(uint256)");

export const PANIC_CODES = {
  0x00: "generic compiler-inserted panic",
  0x01: "assert(cond) failed",
  0x11: "arithmetic overflow or underflow outside an unchecked block",
  0x12: "division or modulo by zero",
  0x21: "conversion of an out-of-range value into an enum",
  0x22: "access to an incorrectly encoded storage byte array",
  0x31: "pop() on an empty array",
  0x32: "array index out of bounds",
  0x41: "allocation of too much memory",
  0x51: "call to an uninitialised internal function",
};

// Known custom errors: [signature, [types...]]. Types we can render.
const REGISTRY = [
  // ERC-6093, the standard token error set.
  ["ERC20InsufficientBalance(address,uint256,uint256)", ["address", "uint256", "uint256"]],
  ["ERC20InsufficientAllowance(address,uint256,uint256)", ["address", "uint256", "uint256"]],
  ["ERC20InvalidApprover(address)", ["address"]],
  ["ERC20InvalidReceiver(address)", ["address"]],
  ["ERC20InvalidSender(address)", ["address"]],
  ["ERC20InvalidSpender(address)", ["address"]],
  ["ERC721InvalidOwner(address)", ["address"]],
  ["ERC721NonexistentToken(uint256)", ["uint256"]],
  ["ERC721IncorrectOwner(address,uint256,address)", ["address", "uint256", "address"]],
  ["ERC721InsufficientApproval(address,uint256)", ["address", "uint256"]],
  ["ERC721InvalidApprover(address)", ["address"]],
  ["ERC721InvalidOperator(address)", ["address"]],
  ["ERC721InvalidReceiver(address)", ["address"]],
  ["ERC721InvalidSender(address)", ["address"]],
  ["ERC1155InsufficientBalance(address,uint256,uint256,uint256)", ["address", "uint256", "uint256", "uint256"]],
  // Access control and lifecycle, as emitted by OpenZeppelin 5.x.
  ["OwnableUnauthorizedAccount(address)", ["address"]],
  ["OwnableInvalidOwner(address)", ["address"]],
  ["AccessControlUnauthorizedAccount(address,bytes32)", ["address", "bytes32"]],
  ["ReentrancyGuardReentrantCall()", []],
  ["EnforcedPause()", []],
  ["ExpectedPause()", []],
  ["SafeERC20FailedOperation(address)", ["address"]],
  ["FailedInnerCall()", []],
  // Very common hand-rolled guards.
  ["InsufficientBalance()", []],
  ["InsufficientAllowance()", []],
  ["Unauthorized()", []],
  ["NotOwner()", []],
  ["NotAuthorized()", []],
  ["Paused()", []],
  ["NotPaused()", []],
  ["ZeroAddress()", []],
  ["InvalidAddress()", []],
  ["InvalidAmount()", []],
  ["InvalidSignature()", []],
  ["Expired()", []],
  ["NotExpired()", []],
  ["AlreadyInitialized()", []],
  ["NotInitialized()", []],
  ["CallerIsNotOwner()", []],
  ["TransferFailed()", []],
  ["ApprovalFailed()", []],
];

const BY_SELECTOR = new Map(
  REGISTRY.map(([signature, types]) => [selector(signature), { signature, types }]),
);

/** Render one ABI word according to its declared type. */
function renderArg(type, word) {
  switch (type) {
    case "address":
      return wordToAddress(word);
    case "uint256":
      return wordToBigInt(word).toString();
    case "bytes32":
      return "0x" + strip0x(word);
    default:
      return "0x" + strip0x(word);
  }
}

/**
 * Decode revert data into a structured description.
 * @param {string} data 0x-prefixed revert payload
 */
export function decodeRevert(data) {
  if (!data || data === "0x") {
    return { kind: "empty", summary: "reverted with no data", args: [], raw: "0x" };
  }
  const sel = data.slice(0, 10).toLowerCase();
  const body = "0x" + strip0x(data).slice(8);
  const w = words(body);

  if (sel === ERROR_STRING) {
    // Error(string): word 0 is the offset (0x20), word 1 the length, then bytes.
    const len = w[1] ? Number(wordToBigInt(w[1])) : 0;
    const payload = strip0x(body).slice(64 + 64, 64 + 64 + len * 2);
    const text = hexToUtf8(payload);
    return { kind: "Error(string)", summary: text || "(empty reason string)", args: [text], selector: sel, raw: data };
  }

  if (sel === PANIC) {
    const code = w[0] ? wordToBigInt(w[0]) : 0n;
    const meaning = PANIC_CODES[Number(code)] || "unrecognised panic code";
    return {
      kind: "Panic(uint256)",
      summary: `panic 0x${code.toString(16).padStart(2, "0")} — ${meaning}`,
      args: [code.toString()],
      selector: sel,
      raw: data,
    };
  }

  const known = BY_SELECTOR.get(sel);
  if (known) {
    const args = known.types.map((t, i) => renderArg(t, w[i] || ""));
    return {
      kind: "custom error",
      summary: `${known.signature.split("(")[0]}(${args.join(", ")})`,
      signature: known.signature,
      args,
      selector: sel,
      raw: data,
    };
  }

  return {
    kind: "unknown",
    summary: `unrecognised custom error, selector ${sel}`,
    args: [],
    selector: sel,
    raw: data,
    hint: "the selector is not in the built-in registry; the 4-byte signature is reportable to 4byte.directory",
  };
}

/** Decode hex to UTF-8 without Node's Buffer (this file must run in Workers). */
function hexToUtf8(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

/** Expose the registry so tests and the UI can show what is recognised. */
export const knownErrors = () =>
  REGISTRY.map(([signature]) => ({ signature, selector: selector(signature) }));
