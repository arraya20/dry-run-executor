// API tests. These run the real Pages Function against a real HTTP JSON-RPC
// server on localhost — not a mock injected into the function, but a socket the
// function must actually talk to. Anything that would only work with a stubbed
// fetch (bad headers, unparsed errors, wrong quantities) fails here.
//
// The stub is deliberately opinionated: eth_call succeeds only at or above
// MIN_GAS, so the bisection in measureMinimumGas has a ground truth to find.

import { createServer } from "node:http";
import { suite, test, run, ok, eq, includes } from "./harness.mjs";

const CHAIN_ID = 1672n;
const MIN_GAS = 50_000n; // the stub's true gas requirement
const NODE_ESTIMATE = 70_000n; // what the stub's eth_estimateGas claims

const SENDER = "0x651940ebb947408151aa46d5e9677d583b757bbc";
const EOA = "0x000000000000000000000000000000000000dead";
const CONTRACT = "0x6b0a44c64190279f7034b77c13a566e914fe5ec4";

const GWEI = 1_000_000_000n;

function makeNode() {
  const state = {
    balances: new Map([[SENDER.toLowerCase(), 10n ** 19n]]), // 10 PROS
    code: new Map([[CONTRACT.toLowerCase(), "0x6080604052"]]),
    mode: "ok", // "ok" | "revert" | "down"
    tokenReadsFail: false, // only the ERC20 getters fail, not the simulated call
    logQueries: 0,
    callCount: 0,
  };

  const ok = (result) => ({ jsonrpc: "2.0", id: 1, result });
  const fail = (code, message, data) => ({ jsonrpc: "2.0", id: 1, error: { code, message, ...(data ? { data } : {}) } });

  const handle = (method, params) => {
    switch (method) {
      case "eth_chainId":
        return ok("0x" + CHAIN_ID.toString(16));
      case "eth_blockNumber":
        return ok("0x100");
      case "eth_gasPrice":
        return ok("0x" + (10n * GWEI).toString(16));
      case "eth_feeHistory":
        return ok({ oldestBlock: "0xfe", baseFeePerGas: ["0x" + (10n * GWEI).toString(16), "0x" + (10n * GWEI).toString(16)] });
      case "eth_maxPriorityFeePerGas":
        return ok("0x0");
      case "eth_getLogs":
        state.logQueries++;
        return ok([]);
      case "eth_getCode": {
        const addr = String(params[0]).toLowerCase();
        return ok(state.code.get(addr) || "0x");
      }
      case "eth_getBalance": {
        const addr = String(params[0]).toLowerCase();
        return ok("0x" + (state.balances.get(addr) || 0n).toString(16));
      }
      case "eth_getTransactionCount":
        return ok("0x1");
      case "eth_estimateGas":
        return ok("0x" + NODE_ESTIMATE.toString(16));
      case "eth_call": {
        state.callCount++;
        if (state.mode === "down") return fail(-32000, "node is unavailable");
        // Token context is read with four separate getters. Make them fail while
        // the transaction itself still simulates, which is exactly the case that
        // used to collapse into "standard: false" and a clean verdict.
        const data = String((params[0] || {}).data || "");
        const TOKEN_GETTERS = ["0x70a08231", "0x313ce567", "0x95d89b41", "0xdd62ed3e"];
        if (state.tokenReadsFail && TOKEN_GETTERS.some((sel) => data.startsWith(sel))) {
          return fail(-32011, "cu limit exceeded");
        }
        if (state.mode === "revert") {
          // Error(string) "nope"
          return fail(
            3,
            "execution reverted: nope",
            "0x08c379a0" +
              "0000000000000000000000000000000000000000000000000000000000000020" +
              "0000000000000000000000000000000000000000000000000000000000000004" +
              "6e6f7065000000000000000000000000000000000000000000000000000000",
          );
        }
        const tx = params[0] || {};
        if (tx.gas !== undefined) {
          const gas = BigInt(tx.gas);
          // Below the true requirement the EVM runs out of gas. The node reports
          // that the same way it reports a revert, which is why the bisection
          // relies on the "succeeds at the ceiling" invariant instead.
          if (gas < MIN_GAS) return fail(3, "execution reverted");
        }
        if (BigInt(tx.value || "0x0") > (state.balances.get(String(tx.from).toLowerCase()) || 0n)) {
          return fail(-32029, "caller does not have enough funds for value transfer");
        }
        return ok("0x" + "0".repeat(62) + "01");
      }
      default:
        return fail(-32601, `method ${method} not found`);
    }
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      }
      const reply = Array.isArray(payload)
        ? payload.map((p) => ({ ...handle(p.method, p.params || []), id: p.id }))
        : { ...handle(payload.method, payload.params || []), id: payload.id };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });

  return { server, state };
}

const { server, state } = makeNode();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const RPC_URL = `http://127.0.0.1:${port}`;

console.log(`  (json-rpc stub listening on ${RPC_URL})`);

// Import after the stub is up so a module-level fetch cannot fire early.
const { onRequestPost, onRequestGet } = await import("../functions/api/simulate.js");

const post = async (body) => {
  const res = await onRequestPost({
    request: new Request("http://localhost/api/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env: { PHAROS_RPC: RPC_URL },
  });
  return res;
};

suite("api");

test("a valid transaction returns a measured report", async () => {
  const res = await post({ from: SENDER, to: EOA, value: "1000" });
  eq(res.status, 200);
  const report = await res.json();
  eq(report.verdict, "READY");
  eq(report.chain.id, 1672);
  ok(report.gas.expectedIsMeasured, "expected gas must come from the bisection");
});

test("the bisection finds the stub's true minimum over real HTTP", async () => {
  const res = await post({ from: SENDER, to: EOA, value: "1" });
  const report = await res.json();
  eq(report.gas.expected, MIN_GAS.toString(), "must converge on the real requirement");
  ok(report.gas.measuredProbes > 0, "probes are counted");
});

test("the node's inflated estimate is reported as a gap, not used as the answer", async () => {
  const res = await post({ from: SENDER, to: EOA, value: "1" });
  const report = await res.json();
  eq(report.gas.nodeEstimate, NODE_ESTIMATE.toString());
  // 70000 vs 50000 measured
  eq(report.gas.nodeEstimateOverMeasuredPercent, 40);
  ok(report.gas.expectedSource.includes("bisection"));
});

test("the gas limit carries headroom above the measurement", async () => {
  const res = await post({ from: SENDER, to: EOA, value: "1" });
  const report = await res.json();
  ok(BigInt(report.gas.limit) > BigInt(report.gas.expected), "limit must exceed the measurement");
});

test("an unaffordable sender is INSUFFICIENT-FUNDS, not ready", async () => {
  state.balances.set(SENDER.toLowerCase(), 0n);
  const res = await post({ from: SENDER, to: EOA, value: "1" });
  const report = await res.json();
  eq(report.verdict, "INSUFFICIENT-FUNDS");
  eq(report.funding.sufficient, false);
  ok(report.blocking.length > 0, "a blocking reason must be stated");
  ok(BigInt(report.funding.shortfallWei) > 0n);
  state.balances.set(SENDER.toLowerCase(), 10n ** 19n);
});

test("a value larger than the balance is caught before sending", async () => {
  const res = await post({ from: SENDER, to: EOA, value: (10n ** 20n).toString() });
  const report = await res.json();
  eq(report.verdict, "INSUFFICIENT-FUNDS");
});

test("a reverting call is reported with its decoded reason", async () => {
  state.mode = "revert";
  const res = await post({ from: SENDER, to: CONTRACT, data: "0xa9059cbb" });
  const report = await res.json();
  eq(report.verdict, "WILL-REVERT");
  eq(report.execution.status, "reverts");
  includes(report.execution.revert.summary, "nope");
  eq(report.gas.expected, null, "a revert has no gas figure to report");
  state.mode = "ok";
});

test("a caller-supplied verdict is refused with 400 and the field named", async () => {
  for (const field of ["mockRevert", "willSucceed", "gasUsed", "verdict"]) {
    const res = await post({ from: SENDER, to: EOA, [field]: true });
    eq(res.status, 400, `${field} must be a 400`);
    const body = await res.json();
    eq(body.field, field);
    includes(body.error, field);
  }
});

test("an unknown field is refused rather than ignored", async () => {
  const res = await post({ from: SENDER, to: EOA, flavour: "vanilla" });
  eq(res.status, 400);
  const body = await res.json();
  includes(body.error, "flavour");
});

test("a malformed address is a 400, not a 500", async () => {
  const res = await post({ from: "0xnope", to: EOA });
  eq(res.status, 400);
  const body = await res.json();
  eq(body.field, "from");
});

test("malformed JSON is refused", async () => {
  const res = await post("{not json");
  eq(res.status, 400);
  const body = await res.json();
  eq(body.code, "bad-json");
});

test("a JSON array is not a transaction", async () => {
  const res = await post([{ from: SENDER }]);
  eq(res.status, 400);
});

test("GET is not allowed on the simulate endpoint", async () => {
  const res = await onRequestGet();
  eq(res.status, 405);
});

test("a node failure becomes a 502, never a clean-looking report", async () => {
  state.mode = "down";
  const res = await post({ from: SENDER, to: EOA });
  eq(res.status, 502, "an outage must not be dressed up as success");
  const body = await res.json();
  eq(body.code, "upstream-failure");
  ok(!body.verdict, "no verdict may be emitted when the node failed");
  state.mode = "ok";
});

test("a chain mismatch stops the simulation", async () => {
  const res = await onRequestPost({
    request: new Request("http://localhost/api/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: SENDER, to: EOA }),
    }),
    env: { PHAROS_RPC: RPC_URL, PHAROS_EXPECTED_CHAIN_ID: "999" },
  });
  eq(res.status, 502);
  const body = await res.json();
  includes(String(body.detail || body.error), "chain");
});

test("an unreadable token context downgrades the verdict instead of claiming READY", async () => {
  // approve(address,uint256) with a non-zero amount, so the tool must read
  // balanceOf/decimals to describe what the caller is handing over.
  const data = "0x095ea7b3" + "0".repeat(24) + CONTRACT.slice(2) + "0".repeat(63) + "1";
  state.tokenReadsFail = true;
  const res = await post({ from: SENDER, to: CONTRACT, data });
  eq(res.status, 200);
  const report = await res.json();
  eq(report.token.readStatus, "unavailable", "a failed getter is not an empty answer");
  eq(report.verdict, "INCOMPLETE", "READY would mean the token context was measured");
  ok(
    report.blocking.some((line) => line.includes("token context could not be read")),
    "the reason must be in blocking, not only in the token object",
  );
  ok(report.token.readErrors.length > 0, "the node's own message must survive");
  state.tokenReadsFail = false;
});

test("the report is JSON-serialisable despite BigInt internals", async () => {
  const res = await post({ from: SENDER, to: EOA, value: "1" });
  const text = JSON.stringify(await res.json());

  // JSON.stringify throws outright on a BigInt, so reaching this line already
  // proves serialisability. What can still slip through is a bigint that was
  // stringified somewhere and then re-typed, or a literal "123n" left in a
  // string field by an over-eager formatter.
  ok(!/:\s*-?\d+n(?![\w])/.test(text), "no BigInt literal may appear as a value");
  ok(!text.includes("\"undefined\""), "no undefined may be rendered as a string");

  const parsed = JSON.parse(text);
  eq(typeof parsed.gas.expected, "string", "gas figures travel as decimal strings");
  eq(typeof parsed.chain.id, "number");
});

test("nothing in the report claims an observed post-state", async () => {
  const res = await post({ from: SENDER, to: EOA, value: "1" });
  const report = await res.json();
  ok(Array.isArray(report.notMeasured) && report.notMeasured.length > 0, "the not-measured list must never be empty");
  const joined = report.notMeasured.join(" ").toLowerCase();
  ok(joined.includes("post-state"), "post-state honesty must be explicit");
});

test("the submit payload is unsigned and complete", async () => {
  const res = await post({ from: SENDER, to: EOA, value: "1" });
  const report = await res.json();
  eq(report.verdict, "READY");
  eq(report.submit.chainId, 1672);
  eq(report.submit.from, SENDER);
  ok(report.submit.gas > 0);
  ok(!("signature" in report.submit) && !("signedTransaction" in report.submit), "the tool must not sign");
});

test("a blocked simulation withholds the submit payload and closes the gate", async () => {
  state.mode = "revert";
  const res = await post({ from: SENDER, to: CONTRACT, data: "0xa9059cbb" });
  const report = await res.json();
  eq(report.verdict, "WILL-REVERT");
  eq(report.submit, null, "a payload for a reverting transaction is an invitation to send it");
  eq(report.gate.allowed, false);
  ok(report.gate.reasons.length > 0, "the gate states why it is closed");
  ok(
    !report.blocking.some((line) => line.includes("no gas limit")),
    "a revert must not also be reported as a missing gas limit",
  );
  state.mode = "ok";
});

test("an unaffordable sender also gets no submit payload", async () => {
  state.balances.set(SENDER.toLowerCase(), 0n);
  const res = await post({ from: SENDER, to: EOA, value: "1" });
  const report = await res.json();
  eq(report.verdict, "INSUFFICIENT-FUNDS");
  eq(report.submit, null);
  eq(report.gate.allowed, false);
  state.balances.set(SENDER.toLowerCase(), 10n ** 19n);
});

test("a cleared simulation opens the gate", async () => {
  const res = await post({ from: SENDER, to: EOA, value: "1" });
  const report = await res.json();
  eq(report.gate.allowed, true);
  ok(report.submit !== null);
});

test("expected cost is priced at what is charged, not at the fee ceiling", async () => {
  const res = await post({ from: SENDER, to: EOA, value: "1" });
  const report = await res.json();
  // 10 gwei base fee, 0 tip. maxFeePerGas carries a 20% buffer on top.
  eq(report.fees.effectiveGasPrice, (10n * GWEI).toString());
  eq(report.cost.expectedWei, (MIN_GAS * 10n * GWEI).toString());
  ok(BigInt(report.fees.maxFeePerGas) > BigInt(report.fees.effectiveGasPrice), "the ceiling sits above the charged price");
  eq(report.cost.maxWei, (BigInt(report.gas.limit) * BigInt(report.fees.maxFeePerGas)).toString());
});

test("a native transfer reports sender and recipient before and after", async () => {
  const res = await post({ from: SENDER, to: EOA, value: "1000" });
  const report = await res.json();
  eq(report.outcome.status, "predicted");
  const sender = report.outcome.rows.find((r) => r.account === SENDER && r.kind === "native");
  const recipient = report.outcome.rows.find((r) => r.account === EOA && r.kind === "native");
  ok(sender && recipient, "both sides of the transfer must appear");

  const cost = BigInt(report.cost.expectedWei);
  eq(sender.before, (10n ** 19n).toString());
  eq(sender.after, (10n ** 19n - 1000n - cost).toString(), "sender pays value and expected gas");
  eq(recipient.before, "0");
  eq(recipient.after, "1000");
  eq(sender.observed, false, "the after figure is derived");
  includes(report.outcome.basis, "derived");
});

test("a token transfer reports token balances before and after", async () => {
  // The stub answers every token read with 1, so a transfer of 1 takes the
  // sender from 1 to 0 and the recipient from 1 to 2.
  const data = "0xa9059cbb" + EOA.slice(2).padStart(64, "0") + "0".repeat(63) + "1";
  const res = await post({ from: SENDER, to: CONTRACT, data });
  const report = await res.json();
  eq(report.outcome.status, "predicted");
  const sender = report.outcome.rows.find((r) => r.account === SENDER && r.kind === "token-balance");
  const recipient = report.outcome.rows.find((r) => r.account === EOA && r.kind === "token-balance");
  eq(sender.before, "1");
  eq(sender.after, "0");
  eq(recipient.before, "1");
  eq(recipient.after, "2");
});

test("a derived change that cannot hold gives no after figure instead of a negative one", async () => {
  // Sending 5 when the chain says the holder has 1: the arithmetic would go negative.
  const data = "0xa9059cbb" + EOA.slice(2).padStart(64, "0") + "0".repeat(63) + "5";
  const res = await post({ from: SENDER, to: CONTRACT, data });
  const report = await res.json();
  const sender = report.outcome.rows.find((r) => r.account === SENDER && r.kind === "token-balance");
  eq(sender.after, null);
  includes(sender.note, "below zero");
});

test("a failing call predicts no outcome", async () => {
  state.mode = "revert";
  const res = await post({ from: SENDER, to: CONTRACT, data: "0xa9059cbb" });
  const report = await res.json();
  eq(report.outcome.status, "not-predicted");
  eq(report.outcome.rows.length, 0);
  state.mode = "ok";
});

test("a block tag that does not name one block is a 400 naming the field", async () => {
  for (const blockTag of ["abc", "pending", "earliest", "-1", "1.5"]) {
    const res = await post({ from: SENDER, to: EOA, blockTag });
    eq(res.status, 400, `${blockTag} must be a 400, not a 502`);
    const body = await res.json();
    eq(body.field, "blockTag");
  }
});

test("a numeric block tag is pinned, and one ahead of head is refused", async () => {
  const ok1 = await post({ from: SENDER, to: EOA, value: "1", blockTag: "0x80" });
  eq(ok1.status, 200);
  eq((await ok1.json()).chain.block, 128);

  const dec = await post({ from: SENDER, to: EOA, value: "1", blockTag: "64" });
  eq((await dec.json()).chain.block, 64);

  const ahead = await post({ from: SENDER, to: EOA, blockTag: "0x9999" });
  eq(ahead.status, 400);
});

const failures = await run();

// Close only after the tests have actually run. Closing here rather than before
// run() was the first version of this file, and it made every request fail with
// "fetch failed" while the harness still reported a tidy summary.
await new Promise((resolve) => server.close(resolve));
process.exit(failures === 0 ? 0 : 1);
