import { formatUnits } from "./hex.mjs";

// Render a dry-run report for a terminal or a chat message.
//
// The ordering is deliberate: verdict first, then what the transaction claims to
// do, then what it will cost, then what stopped it, and finally what this tool
// could not see. The last section is never empty.

const RULE = "─".repeat(64);

const PROS = (wei) => (wei === null || wei === undefined ? "unknown" : formatUnits(wei, 18));

const gwei = (wei) => {
  if (wei === null || wei === undefined) return "unknown";
  const v = BigInt(wei);
  const whole = v / 1_000_000_000n;
  const frac = (v % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
};

const num = (value) =>
  value === null || value === undefined ? "—" : Number(value).toLocaleString("en-US");

const short = (addr) => (addr && addr.length > 14 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr);

const VERDICT_LABEL = {
  READY: "READY — this transaction should succeed as described",
  "WILL-REVERT": "WILL REVERT — do not send as-is",
  "INSUFFICIENT-FUNDS": "INSUFFICIENT FUNDS — the sender cannot pay for this",
  INCOMPLETE: "INCOMPLETE — some figure needed to send is missing",
};

export function renderText(report) {
  const out = [];
  const push = (line = "") => out.push(line);

  push(`DRY RUN · Pharos Pacific (chain ${report.chain.id}) · block ${num(report.chain.block)}`);
  push(RULE);
  push(`VERDICT  ${VERDICT_LABEL[report.verdict] || report.verdict}`);
  push();

  push("INTENT");
  push(`  ${report.intent.describe}`);
  if (report.intent.amountHuman) push(`  amount     ${report.intent.amountHuman}`);
  if (report.intent.scary) push("  warning: this grants broad or unlimited authority");
  if (report.intent.warning) push(`  warning: ${report.intent.warning}`);
  push();

  push("EXECUTION");
  if (report.execution.status === "succeeds") {
    push("  the call succeeds against real state");
    const rd = report.execution.returnData;
    if (rd && rd !== "0x") push(`  return data  ${rd.length > 74 ? rd.slice(0, 74) + "…" : rd}`);
    else push("  return data  (none)");
  } else if (report.execution.status === "reverts") {
    push("  the call REVERTS against real state");
    push(`  reason       ${report.execution.revert.summary}`);
    if (report.execution.revert.hint) push(`  note         ${report.execution.revert.hint}`);
  } else if (report.execution.status === "insufficient-funds") {
    push("  the node refused the call: the sender cannot cover value + gas");
    push(`  detail       ${report.execution.detail}`);
  } else {
    push(`  could not be determined (${report.execution.status})`);
    if (report.execution.detail) push(`  detail       ${report.execution.detail}`);
  }
  push();

  push("COST");
  if (report.gas.expected) {
    push(`  expected   ${num(report.gas.expected)} gas × ${gwei(report.fees.maxFeePerGas)} gwei = ${PROS(report.cost.expectedWei)} PROS`);
    push(`             source: ${report.gas.expectedSource}`);
  } else {
    push("  expected   unknown — no gas figure could be established");
  }
  if (report.gas.limit) {
    push(`  max        ${num(report.gas.limit)} gas × ${gwei(report.fees.maxFeePerGas)} gwei = ${PROS(report.cost.maxWei)} PROS`);
    push("             the limit submitted; headroom is charged only if used");
  }
  if (report.gas.nodeEstimateOverMeasuredPercent !== null && Math.abs(report.gas.nodeEstimateOverMeasuredPercent) >= 5) {
    push(
      `  node said  ${num(report.gas.nodeEstimate)} gas (${report.gas.nodeEstimateOverMeasuredPercent > 0 ? "+" : ""}${report.gas.nodeEstimateOverMeasuredPercent.toFixed(1)}% versus the measurement)`,
    );
  }
  push(`  intrinsic  ${num(report.gas.intrinsic)} gas is the floor before any contract code runs`);
  push();

  push("FUNDING");
  push(`  sender     ${report.account.address}`);
  push(`  balance    ${report.account.balancePROS} PROS  (nonce ${report.account.nonce})`);
  if (report.funding.sufficient) {
    push("  sufficient for value + maximum gas cost");
  } else {
    push(`  SHORT by ${PROS(report.funding.shortfallWei)} PROS — needs ${PROS(report.funding.requiredWei)} PROS`);
  }
  push();

  if (report.token) {
    push("TOKEN");
    push(`  ${report.token.symbol || "unknown symbol"} · ${report.token.decimals ?? "?"} decimals`);
    if (report.token.balanceFormatted) push(`  balance of ${short(report.token.holder)}  ${report.token.balanceFormatted}`);
    if (report.token.allowance !== null && report.token.allowance !== undefined) {
      push(`  allowance from sender         ${report.token.allowance}`);
    }
    if (!report.token.standard) push("  this address does not answer balanceOf(address): it may not be an ERC-20");
    push();
  }

  push("TARGET");
  push(`  ${report.target.address}`);
  push(
    report.target.isContract
      ? `  contract with ${num(report.target.codeSize)} bytes of code`
      : "  no code at this address: it is an externally owned account",
  );
  push();

  if (report.intent.deltas?.length) {
    push("EXPECTED CHANGES (derived from calldata, not observed)");
    for (const d of report.intent.deltas) {
      const sign = String(d.change).startsWith("-") ? "" : "+";
      push(`  ${short(d.account)} ${d.field} ${sign}${d.change}${d.spender ? ` for spender ${short(d.spender)}` : ""}`);
    }
    push();
  }

  if (report.blocking.length) {
    push("BLOCKING");
    for (const b of report.blocking) push(`  ✗ ${b}`);
    push();
  }

  push("NOT MEASURED");
  for (const n of report.notMeasured) push(`  · ${n}`);
  push();

  push("SUBMIT PAYLOAD (unsigned — this tool never signs or broadcasts)");
  push(`  chainId ${report.submit.chainId}  nonce ${report.submit.nonce}  type ${report.submit.type}`);
  push(`  to      ${report.submit.to}`);
  push(`  gas     ${report.submit.gas ?? "unavailable"}`);
  push(`  fees    maxFee ${gwei(report.submit.maxFeePerGas)} gwei, tip ${gwei(report.submit.maxPriorityFeePerGas)} gwei`);
  push(`  value   ${PROS(BigInt(report.submit.value))} PROS`);
  push(`  data    ${report.submit.data.length > 74 ? report.submit.data.slice(0, 74) + "…" : report.submit.data}`);

  return out.join("\n");
}

export const renderJSON = (report) => JSON.stringify(report, null, 2);
