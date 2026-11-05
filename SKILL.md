---
name: dry-run-executor
description: Use when a Pharos/EVM transaction must be simulated before signing — measures real gas by bisection, decodes revert reasons, checks affordability, and states what it cannot see.
---

# dry-run-executor

Simulate a transaction against live chain state and get a verdict you can gate a
send on. Signed transactions are never produced and nothing is broadcast.

## When to use this

- Before any write to a contract, to know whether it reverts and what it costs.
- When a wallet holds tokens but no native balance, to see the failure before
  submitting rather than after.
- When a transaction's cost needs to be budgeted honestly, without the node's
  30%-inflated estimate.
- When a user asks "will this work?" about calldata they were given.

## Commands

```bash
# human report
node bin/dry-run.mjs --from 0x… --to 0x… [--data 0x…] [--value wei]

# machine-readable
node bin/dry-run.mjs --from 0x… --to 0x… --json

# skip the historical gas sample (fewer RPC calls)
node bin/dry-run.mjs --from 0x… --to 0x… --no-history

# pin to a block instead of latest
node bin/dry-run.mjs --from 0x… --to 0x… --block 22117853
```

Exit codes: `0` READY, `1` do not send, `2` bad usage / nothing simulated.

Verification of the tool itself:

```bash
npm test              # offline: 38 unit + 18 api
npm run test:live     # 15 tests against Pharos, structure only
npm run verify:chain  # re-derives every external claim from the chain
```

## How the numbers are produced

**Gas.** By bisection on the `gas` field of `eth_call`: find the smallest value at
which the call still succeeds. Measured against real receipts, mean absolute
error is ~6% (worst ~27% on one selector) versus ~+42% for `eth_estimateGas`
on this node. Accuracy is not uniform across selectors; both the mean and the
worst case are reported. The reported limit adds 15% headroom over the
measurement.

**Revert reason.** `eth_call` at a pinned block; the payload is decoded as
`Error(string)`, `Panic(uint256)`, or a named ERC-6093 error such as
`ERC20InsufficientBalance(sender, balance, needed)`. Registry selectors are
computed with the project's own keccak, and that keccak is checked against
`eth_getProof.codeHash` on a 2,739-byte contract.

**Affordability.** `balance >= value + gasLimit × maxFeePerGas`. This check has to
live here because `eth_estimateGas` answers happily for a sender with zero
balance as long as `value` is zero — verified live.

**Intent.** Known selectors decode into words plus derived deltas. An `approve`
of `uint256` max is flagged as unlimited; `approve(…, 0)` is described as a
revoke, not a grant.

## Pitfalls, learned on this chain

- **`eth_estimateGas` is not a budget.** It overestimated by 29–34% on everything
  sampled. Never present it as expected cost.
- **A revert and "out of gas" are indistinguishable** on Pharos: both arrive as
  `code 3` with empty data. Bisection therefore relies on the "succeeds at the
  upper bound" invariant, not on error text.
- **`eth_getLogs` rejects ranges above ~1,000 blocks** with an HTTP 400. Walk
  windows; do not request 5,000 at once.
- **`prestateTracer` is rejected**, `eth_simulateV1` absent, JS tracers ignored,
  `callTracer` drops logs, and `structLogs` omits memory and truncates on large
  calls. Post-state is unobservable — derive deltas from calldata and label them.
- **`structLogs` gas costs cannot be summed** to a gas figure: some entries carry
  sentinel values and the trace is truncated. Bisection is the only reliable
  route.
- **Pin one block** for every read, or the balance check and the call describe
  different worlds.
- **Recent blocks are often empty.** Selecting a funded sender by scanning the
  last few blocks fails; use senders from token logs or a known-active address.

## Never

- Accept a verdict-shaped field from the caller (`mockRevert`, `willSucceed`,
  `gasUsed`, `status`). The request schema refuses them with HTTP 400 naming the
  field.
- Present a derived balance delta as an observed one.
- Turn a node outage into a clean report. A failed call is `502` / `INCOMPLETE`,
  never `READY`.
- Sign or broadcast.
