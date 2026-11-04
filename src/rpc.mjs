// Minimal JSON-RPC client.
//
// Two rules, both learned the hard way on public Pharos nodes:
//   1. A rate-limit or transport failure must retry; a revert must NOT. A revert
//      is an answer, and retrying it wastes the caller's time and hides the error.
//   2. An RPC error is never converted into a default value. Callers get a thrown
//      RpcError carrying the node's own code and data, so a failed read is never
//      mistaken for "zero".

export class RpcError extends Error {
  constructor(method, error) {
    const code = error?.code;
    const message = error?.message || "unknown RPC error";
    super(`${method}: ${message}`);
    this.name = "RpcError";
    this.method = method;
    this.code = code;
    this.data = error?.data;
    this.reverted = code === 3 || /revert/i.test(message);
  }
}

export class TransportError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "TransportError";
    this.cause = cause;
  }
}

// Errors worth retrying: transport failures and node-side throttling.
const RETRYABLE_CODES = new Set([-32005, -32029, -32603, 429, 502, 503, 504]);
const retryable = (err) =>
  err instanceof TransportError || RETRYABLE_CODES.has(err?.code) || /rate limit|too many|timeout|temporar/i.test(err?.message || "");

export const DEFAULT_TIMEOUT_MS = 20_000;

export function createRpc({ url, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2, backoffMs = 400 } = {}) {
  if (!url) throw new Error("createRpc requires a url");
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") throw new Error("no fetch implementation available");
  let nextId = 1;

  async function once(method, params) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        signal: controller?.signal,
      });
      if (!res.ok) throw new TransportError(`HTTP ${res.status} from ${method}`);
      let json;
      try {
        json = await res.json();
      } catch (err) {
        throw new TransportError(`${method} returned a non-JSON body`, err);
      }
      if (json.error) throw new RpcError(method, json.error);
      if (!("result" in json)) throw new RpcError(method, { code: -32603, message: "response had no result" });
      return json.result;
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new TransportError(`${method} failed: ${err?.message || err}`, err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function call(method, params = []) {
    let attempt = 0;
    for (;;) {
      try {
        return await once(method, params);
      } catch (err) {
        if (attempt >= retries || !retryable(err)) throw err;
        const wait = backoffMs * 2 ** attempt;
        attempt++;
        if (typeof setTimeout === "function") await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  return { url, call };
}

/**
 * Confirm the node is the chain we think it is. A simulation answered by the
 * wrong chain is worse than no simulation, so this is checked once per run.
 */
export async function assertChain(rpc, expectedChainId) {
  const got = await rpc.call("eth_chainId", []);
  const id = Number(BigInt(got));
  if (Number.isFinite(expectedChainId) && id !== expectedChainId) {
    throw new Error(`wrong chain: node reports ${id}, expected ${expectedChainId}`);
  }
  return id;
}
