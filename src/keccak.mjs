// Keccak-256, written from scratch.
//
// Ethereum uses the original Keccak submission (padding byte 0x01), not the
// later NIST SHA3-256 standardisation (0x06). Getting that one byte wrong
// produces digests that look plausible and are wrong, so the constants and the
// padding are both pinned by test vectors in test/unit.test.mjs.
//
// Lanes are BigInt. This is not fast; it is auditable. The tool hashes a few
// dozen short strings per run, so clarity beats throughput here.

const MASK = (1n << 64n) - 1n;

// Round constants for the iota step, 24 rounds.
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets, indexed as x + 5*y (the rho step).
const ROT = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

const rotl = (v, n) => {
  if (n === 0) return v & MASK;
  const b = BigInt(n);
  return ((v << b) | (v >> (64n - b))) & MASK;
};

function keccakF(a) {
  const c = new Array(5);
  const b = new Array(25);

  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) a[x + y] ^= d;
    }
    // rho + pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const from = x + 5 * y;
        const to = y + 5 * ((2 * x + 3 * y) % 5);
        b[to] = rotl(a[from], ROT[from]);
      }
    }
    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        a[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
      }
    }
    // iota
    a[0] ^= RC[round];
  }
  return a;
}

const RATE = 136; // 1088-bit rate for a 256-bit capacity

/** @param {Uint8Array} bytes @returns {Uint8Array} 32-byte digest */
export function keccak256Bytes(bytes) {
  const a = new Array(25).fill(0n);

  // Multi-rate padding: 0x01 ... 0x80, with the first pad byte absorbing the
  // 0x01 domain separator (this is what distinguishes Keccak from SHA3).
  const padded = new Uint8Array(Math.floor(bytes.length / RATE) * RATE + RATE);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]);
      a[i] ^= lane;
    }
    keccakF(a);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = a[i];
    for (let k = 0; k < 8; k++) {
      out[i * 8 + k] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

const enc = new TextEncoder();

/** @param {string} text @returns {Uint8Array} */
export const keccak256Text = (text) => keccak256Bytes(enc.encode(text));

/** @param {string} text @returns {string} 0x-prefixed digest */
export function keccak256Hex(text) {
  return "0x" + [...keccak256Text(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** First 4 bytes of keccak256(signature), as 0x-prefixed hex. */
export function selector(signature) {
  return keccak256Hex(signature.replace(/\s+/g, "")).slice(0, 10);
}

/** Full 32-byte event topic for a signature. */
export const eventTopic = (signature) => keccak256Hex(signature.replace(/\s+/g, ""));
