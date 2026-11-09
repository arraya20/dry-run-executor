# dry-run-executor

Simulate a Pharos transaction against real chain state before you sign it.

Answers five questions, each with a number that came from a node rather than from
an assumption:

1. **Will it revert?** Executed via `eth_call` at a pinned block. The failure is
   decoded — `Error(string)`, `Panic(uint256)`, or a named ERC-6093 custom error.
2. **What will it cost?** Gas measured by bisection, not taken from the node's
   estimator, and priced with the fee data read from the chain.
3. **Can I afford it?** Balance compared against value plus the maximum gas cost.
   The node's own estimator does not do this check.
4. **What am I actually authorising?** Calldata decoded into an intent, with
   unlimited approvals flagged.
5. **What changes?** Sender and recipient balances (native or token) before and
   after. "Before" is read from the chain at the pinned block; "after" is
   derived from the calldata and labelled as such, because this node cannot
   observe post-state.

It never signs and never broadcasts. The output is an unsigned payload and a
verdict; the decision stays with you.

---

## The problem this replaces

The inherited version of this project computed gas as:

```js
const gas = 21000 + (data.length / 2) * 16 + 35000;
```

and took its revert verdict from a caller-supplied flag:

```js
willRevert: input.mockRevert
```

So it returned a confident report about a transaction it had never executed, and
its test suite "proved" revert prediction by asking for a revert. Nothing touched
a chain. Both of those are gone: the request schema no longer has a field for a
conclusion, and every figure comes from a node.

---

## Why bisection instead of `eth_estimateGas`

This is the central claim, and it is measured rather than asserted. Replaying
successful historical transfers at their parent block and comparing both methods
against the `gasUsed` the receipt actually recorded (`npm run verify:chain`):

| transaction | receipt | bisection | error | node estimate | error |
|---|---|---|---|---|---|
| `0x095ea7b3` | 53,996 | 54,349 | +0.65% | 69,682 | +29.1% |
| `0xb4430b99` | 105,102 | 106,278 | +1.12% | 141,447 | +34.6% |
| `0xba087652` | 195,301 | 197,894 | +1.33% | 260,237 | +33.2% |
| `0x095ea7b3` | 36,896 | 36,976 | +0.22% | 48,516 | +31.5% |
| `0x2e6cb841` | 150,493 | 190,610 | +26.66% | 277,084 | +84.1% |

Mean absolute error: **5.99%** (bisection) versus **+42.5%** (the node's
estimate), worst **26.66%**.

The bisection searches for the smallest `gas` value at which `eth_call` still
succeeds, which lands on the real requirement. It costs about 17 cheap calls.

Two things worth knowing, because they shaped the implementation and the honest
limits:

1. This node answers "not enough gas" with the same `code 3` revert it uses for
   a genuine revert, empty data and all. The error text cannot distinguish them,
   so the bisection does not try. It first proves the call succeeds at a
   generous upper bound; after that, any failure at a lower bound can only mean
   the bound is too low. That invariant is what makes the search sound.

2. Accuracy is not uniform. One selector (`0x2e6cb841`) over-measures by ~27%
   while the others sit near 1%. It is not hidden from the table above: the mean
   and the worst case are both reported, so a caller budgeting gas sees the real
   spread rather than a cherry-picked sample. The node's estimate over that same
   transaction is +84%, so bisection is still the better bound — just not
   uniformly, and the headroom below exists partly for that reason.

The node's estimate is still reported — as a separate number, labelled as the
node's, with the gap shown. It is never used as the budget.

### Where the honest limit is

The limit submitted carries 15% headroom over the measurement, because state can
shift between the pinned block and inclusion. Headroom is free unless used: you
are billed for gas consumed, not for the limit submitted.

Reverts under a bad gas bound and refunds for cleared storage both mean the
measured minimum is not always identical to the receipt figure. The numbers above
are a measurement, not a proof, and they move as the sampler picks different
transactions each run.

---

## What this tool cannot see, and says so

Pharos nodes expose a narrow tracer surface. Checked live, not assumed
(`npm run verify:chain`):

- `prestateTracer` → `PARAM_PARSE_ERROR: prestateTracer currently not supported`
- `eth_simulateV1` → absent
- JS tracers → silently ignored, the default opcode logger is returned instead
- `callTracer` → works, but drops logs even with `withLog: true`
- `structLogs` → omits `memory`, so LOG payloads cannot be decoded (topics only)
- `structLogs` → truncated on larger calls (723 steps for a transaction whose
  receipt carries 7 logs, zero LOG opcodes present)
- `eth_getLogs` → HTTP 400 above roughly 1,000 blocks per query

Consequence: **post-state cannot be observed on this node.** Balance and
allowance changes are therefore *derived from calldata* and labelled as such in
every report. A fee-on-transfer or rebasing token would make those derived
deltas wrong, and the tool cannot detect that — so it says so instead of
pretending otherwise.

Every report carries a `notMeasured` list, and it is never empty.

---

## Usage

```bash
# plain value transfer
node bin/dry-run.mjs \
  --from 0x25fdb4a165661f07cb52ac55d00d8d191126b058 \
  --to   0x000000000000000000000000000000000000dEaD \
  --value 1000000000000000

# an ERC-20 transfer
node bin/dry-run.mjs \
  --from 0x651940ebb947408151aa46d5e9677d583b757bbc \
  --to   0x6b0a44c64190279f7034b77c13a566e914fe5ec4 \
  --data 0xa9059cbb000000000000000000000000651940ebb947408151aa46d5e9677d583b757bbc0000000000000000000000000000000000000000000000000de0b6b3a7640000

# machine-readable, for an agent or a script
node bin/dry-run.mjs --from 0x… --to 0x… --json
```

The report has an `OUTCOME — before and after (derived, not observed)` section.
A failing call gets `not predicted` instead: a reverted call changes nothing
except gas.

Exit codes are part of the contract, because the point of a dry run is to gate a
send:

| code | meaning |
|---|---|
| 0 | `READY` — simulates cleanly and the sender can pay |
| 1 | do not send — reverts, insufficient funds, or incomplete payload |
| 2 | bad usage — nothing was simulated |

So a script can simply do:

```bash
node bin/dry-run.mjs --from "$FROM" --to "$TO" --data "$DATA" && cast send …
```

### Verdicts

| verdict | meaning |
|---|---|
| `READY` | call succeeds, sender can cover value + max gas |
| `WILL-REVERT` | the chain refused it; the reason is decoded |
| `INSUFFICIENT-FUNDS` | the sender cannot pay, or the value exceeds the balance |
| `INCOMPLETE` | something needed to submit could not be determined |

### Execution gate

A failed simulation blocks execution; it is not a suggestion.

- The `submit` payload is `null` unless the verdict is `READY`. The report
  carries `gate: { allowed, verdict, reasons }` saying why.
- For code that sends, use the guards in `src/simulate.mjs`:

```js
import { executeGuarded } from "./src/simulate.mjs";

// `send` is your signer. It is called only if the simulation is READY;
// otherwise ExecutionBlockedError is thrown and `send` never runs.
const { report, result } = await executeGuarded(tx, send);
```

`assertReady(report)` returns the payload or throws `ExecutionBlockedError`;
`executeIfReady(report, send)` wraps it for an existing report. The tool itself
still never signs.

The verdicts above are kept distinct on purpose.

 An earlier revision collapsed every
non-success into `WILL-REVERT`, which reported a node outage as though the chain
had rejected the transaction.

---

## HTTP API

`POST /api/simulate`

```json
{
  "from": "0x651940ebb947408151aa46d5e9677d583b757bbc",
  "to": "0x6b0a44c64190279f7034b77c13a566e914fe5ec4",
  "data": "0xa9059cbb…",
  "value": "0"
}
```

Permitted fields: `from`, `to`, `data`, `value`, `gas`, `blockTag`, `chainId`.

`blockTag` is `"latest"` (default) or one block number (decimal or `0x`).
`pending` and `earliest` are refused with `400` because they do not name one
fixed block. A number ahead of head is refused too.

The report includes `fees.effectiveGasPrice` (base fee + priority fee). Expected
cost is priced at that; the maximum cost is priced at `maxFeePerGas`.

Anything else is refused with `400` naming the field. Fields that read like a
conclusion — `mockRevert`, `willSucceed`, `gasUsed`, `verdict`, `status`,
`revertReason` — get a specific message rather than a generic rejection, because
accepting the answer as input is the defect this project exists to remove.

A node that refuses the simulation produces `502`, never a `200` with a
plausible-looking report.

---

## Development

```bash
npm test              # 47 unit + 29 api, offline, no install
npm run test:live     # 15 tests against Pharos, opt-in, structure only
npm run verify:chain  # 12 checks re-deriving every external claim
```

The offline suite needs nothing but `node`. The API tests start a real HTTP
JSON-RPC server on localhost whose `eth_call` succeeds only above a known gas
threshold, so the bisection is exercised against a ground truth rather than a
mocked return value.

`verify:chain` needs historical transactions for two checks. If the chain offers
none in the window, those checks print `SKIP` and do not fail the run.
The bisection accuracy figures in this file are a snapshot; the last run
measured a mean error of 0.66% against receipts, versus +29.1% for
`eth_estimateGas`.

The live suite asserts structure, not verdicts: a verdict depends on chain state
that moves every block, and a test that fails because a wallet spent its balance
is a test nobody trusts.

### Running the dashboard

```bash
npx wrangler pages dev public --compatibility-date=2026-01-01 --port=8794
```

Environment overrides: `PHAROS_RPC`, `PHAROS_EXPECTED_CHAIN_ID`.

---

## Layout

```
src/keccak.mjs      Keccak-256 from scratch; verified against eth_getProof.codeHash
src/hex.mjs         quantities, ABI words, unit formatting
src/rpc.mjs         JSON-RPC client; retries transport, never retries a revert
src/revert.mjs      revert decoding, registry selectors computed not hardcoded
src/intent.mjs      calldata → intent + derived balance/allowance deltas
src/gas.mjs         intrinsic gas, bisection, fee quote, historical sampler
src/outcome.mjs     before/after balances: read before, derive after
src/simulate.mjs    the dry run: validation, execution, cost, funding, verdict, gate
src/report.mjs      terminal rendering
bin/dry-run.mjs     CLI
functions/api/      Cloudflare Pages Function
public/             dashboard
scripts/verify-chain.mjs   re-derives every claim in this file from the chain
test/               harness, unit, api, live
```

`src/` and `functions/` contain no Node built-ins, so the same modules run in the
CLI and in a Worker.

---

## Chain facts

Verified by `npm run verify:chain`:

- chain id **1672** (Pharos Pacific), native symbol PROS, 18 decimals
- base fee **10 gwei**, constant across the sampled window; observed priority fee 0
- block gas limit 7,000,000
- `keccak256(bytecode)` reproduces `eth_getProof.codeHash` for a 2,739-byte proxy

## Licence

MIT
