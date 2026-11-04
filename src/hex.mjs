// Hex, quantity and ABI-word helpers.
//
// Conventions, because mixing them silently produces wrong numbers:
//   - "quantity" strings are minimal hex with 0x prefix (JSON-RPC numbers)
//   - "data" strings are 0x-prefixed and even length (bytes)
//   - integers are BigInt internally; number is only for gas-sized values where
//     we have checked the range.

export const toQuantity = (value) => "0x" + BigInt(value).toString(16);

export function fromQuantity(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new Error(`not a hex quantity: ${String(value).slice(0, 40)}`);
  }
  return BigInt(value === "0x" ? 0 : value);
}

export const isAddress = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

export const checksumPrefix = (addr) => addr.slice(2).toLowerCase();

/** Normalise to lowercase 0x-address, rejecting anything malformed. */
export function normaliseAddress(value, field = "address") {
  if (!isAddress(value)) throw new Error(`${field} is not a 20-byte hex address`);
  return value.toLowerCase();
}

export const strip0x = (value) => (value.startsWith("0x") ? value.slice(2) : value);

/** Left-pad a hex payload to a 32-byte ABI word. */
export const padWord = (hex) => strip0x(hex).toLowerCase().padStart(64, "0");

export const wordToBigInt = (word) => BigInt("0x" + strip0x(word || "0").padStart(64, "0"));

/** 32-byte word -> address, taking the low 20 bytes. */
export const wordToAddress = (word) => "0x" + strip0x(word).toLowerCase().slice(-40);

export const wordToBool = (word) => wordToBigInt(word) !== 0n;

export function bigIntToWord(value) {
  const hex = BigInt(value).toString(16);
  if (hex.length > 64) throw new Error("value does not fit in one ABI word");
  return hex.padStart(64, "0");
}

/** Split 0x-data into 32-byte words. Trailing partial word is dropped. */
export function words(data) {
  const body = strip0x(data);
  const out = [];
  for (let i = 0; i + 64 <= body.length; i += 64) out.push(body.slice(i, i + 64));
  return out;
}

export const isHexData = (value) =>
  typeof value === "string" && /^0x([0-9a-fA-F]{2})*$/.test(value);

export const shortHash = (h) => (typeof h === "string" && h.length > 14 ? `${h.slice(0, 10)}…${h.slice(-4)}` : String(h));

/** Format wei as a fixed-point decimal string without floating point error. */
export function formatUnits(wei, decimals = 18, maxFractionDigits = decimals) {
  // Accept hex strings and decimal strings, not just BigInt: the report holds
  // quantities in JSON form, where 0x… is a string.
  const w = typeof wei === "bigint" ? wei : BigInt(wei);
  const negative = w < 0n;
  const v = negative ? -w : w;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  const full = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  let fracStr = full.slice(0, Math.max(1, maxFractionDigits)).replace(/0+$/, "");
  // Truncation may not erase the value: 1000 wei sliced to six places became "",
  // and a report then read "short by 0 PROS". Fall back to the full fraction.
  if (!fracStr && full) fracStr = full;
  const sign = negative ? "-" : "";
  return fracStr ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`;
}

/** Parse a decimal string like "1.5" into wei BigInt. */
export function parseUnits(text, decimals = 18) {
  const s = String(text).trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === "" || s === "." || s === "-") {
    throw new Error(`not a decimal number: ${s}`);
  }
  const negative = s.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? s.slice(1) : s).split(".");
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimal places`);
  const base = 10n ** BigInt(decimals);
  const value = BigInt(whole || "0") * base + BigInt((frac.padEnd(decimals, "0") || "0"));
  return negative ? -value : value;
}

/** Percent formatting that never hides a real gap behind "0%". */
export function formatPercentDelta(actual, reference, digits = 1) {
  if (reference === 0n) return "n/a";
  const pct = (Number(actual) - Number(reference)) / Number(reference);
  if (!Number.isFinite(pct)) return "n/a";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${(pct * 100).toFixed(digits)}%`;
}
