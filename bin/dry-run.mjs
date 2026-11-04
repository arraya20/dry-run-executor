#!/usr/bin/env node
// CLI entry point.
//
// Exit codes are part of the contract, because the point of a dry run is to gate
// a send:
//   0  READY          the transaction simulates cleanly and the sender can pay
//   1  do not send    reverts, insufficient funds, or an incomplete payload
//   2  bad usage      the request could not be understood, nothing was simulated
//
// A script that runs this before submitting can simply check for exit 0.

import { dryRun, PHAROS, RequestError } from "../src/simulate.mjs";
import { renderText, renderJSON } from "../src/report.mjs";

const USAGE = `dry-run — simulate a Pharos transaction against real state before it is sent

  dry-run --from 0x… --to 0x… [--data 0x…] [--value wei] [options]

  --from   0x…      sender address (required)
  --to     0x…      target address (required)
  --data   0x…      calldata (default: empty, i.e. a plain value transfer)
  --value  wei      native value to send, decimal or 0x (default 0)
  --gas    n        gas limit to test instead of deriving one
  --block  n        pin the simulation to a block (default: latest)
  --json            emit the machine-readable report
  --rpc    url      override the RPC endpoint (default ${PHAROS.rpc})
  --no-history      skip the historical gas sample (fewer RPC calls)
  --help            this text

Nothing is signed and nothing is broadcast. The tool produces an unsigned
payload and a verdict; the decision to send stays with you.`;

function parseArgs(argv) {
  const opts = { value: undefined, gas: undefined, block: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--json") { opts.json = true; continue; }
    if (arg === "--no-history") { opts.skipHistory = true; continue; }
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const value = argv[++i];
      if (value === undefined) throw new RequestError(`--${name} needs a value`);
      switch (name) {
        case "from": opts.from = value; break;
        case "to": opts.to = value; break;
        case "data": opts.data = value; break;
        case "value": opts.value = value; break;
        case "gas": opts.gas = value; break;
        case "block": opts.block = value; break;
        case "rpc": opts.rpc = value; break;
        default: throw new RequestError(`unknown option --${name}`);
      }
      continue;
    }
    positional.push(arg);
  }
  if (opts.from === undefined && positional[0]) opts.from = positional[0];
  if (opts.to === undefined && positional[1]) opts.to = positional[1];
  if (opts.data === undefined && positional[2]) opts.data = positional[2];
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}\n`);
    console.error(USAGE);
    process.exit(2);
  }

  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (!opts.from || !opts.to) {
    console.error("error: --from and --to are required\n");
    console.error(USAGE);
    process.exit(2);
  }

  const request = { from: opts.from, to: opts.to };
  if (opts.data !== undefined) request.data = opts.data;
  if (opts.value !== undefined) request.value = opts.value;
  if (opts.gas !== undefined) request.gas = opts.gas;
  if (opts.block !== undefined) request.blockTag = opts.block;

  let report;
  try {
    report = await dryRun(request, { url: opts.rpc, skipHistory: opts.skipHistory });
  } catch (err) {
    if (err instanceof RequestError) {
      console.error(`error: ${err.message}`);
      process.exit(2);
    }
    console.error(`error: ${err?.message || err}`);
    process.exit(2);
  }

  console.log(opts.json ? renderJSON(report) : renderText(report));
  process.exit(report.verdict === "READY" ? 0 : 1);
}

main().catch((err) => {
  console.error(`unexpected failure: ${err?.stack || err}`);
  process.exit(2);
});
