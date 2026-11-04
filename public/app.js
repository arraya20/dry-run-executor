// Dashboard. The only thing it does is post a transaction and render the report.
// It never computes a verdict locally, because a second implementation of the
// rules is a second set of rules that can disagree with the server.

const $ = (id) => document.getElementById(id);

// Money is formatted on the server (decimal strings in the report). A second
// formatter here would be a second set of rounding rules — and it already
// disagreed once, rendering 1000 wei as "0 PROS".

const gwei = (wei) => {
  if (wei === null || wei === undefined) return "unknown";
  const v = BigInt(wei);
  const whole = v / 1_000_000_000n;
  const frac = (v % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
};

const num = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en-US"));
const short = (a) => (a && a.length > 16 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a || "—");

function table(el, rows) {
  el.replaceChildren();
  for (const [k, v, cls] of rows) {
    if (v === undefined) continue;
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = k;
    const td = document.createElement("td");
    td.textContent = v;
    if (cls) td.className = cls;
    tr.append(th, td);
    el.append(tr);
  }
}

const VERDICT_CLASS = {
  READY: "ok",
  "WILL-REVERT": "bad",
  "INSUFFICIENT-FUNDS": "bad",
  INCOMPLETE: "warn",
};

function render(report) {
  $("result").hidden = false;

  const v = $("verdict");
  v.textContent = report.verdict;
  v.className = `verdict ${VERDICT_CLASS[report.verdict] || "warn"}`;

  $("intent").textContent = report.intent.describe;
  const iw = $("intent-warn");
  const extra = [report.intent.warning, report.intent.scary ? "grants broad or unlimited authority" : null].filter(Boolean);
  iw.hidden = extra.length === 0;
  iw.textContent = extra.join(" · ");

  const status = report.execution.status;
  $("execution").textContent =
    status === "succeeds"
      ? "The call succeeds against real state."
      : status === "reverts"
        ? `The call reverts: ${report.execution.revert.summary}`
        : `Could not be determined: ${report.execution.detail || status}`;

  const ed = $("execution-detail");
  const detail = status === "reverts" ? report.execution.revert.hint : report.execution.returnData;
  ed.hidden = !detail;
  ed.textContent = detail || "";

  table($("cost"), [
    ["expected gas", report.gas.expected ? num(report.gas.expected) : "unknown"],
    ["expected cost", report.cost.expectedPROS ? `${report.cost.expectedPROS} PROS` : "unknown"],
    ["source", report.gas.expectedSource],
    ["limit submitted", report.gas.limit ? num(report.gas.limit) : "unavailable"],
    ["maximum cost", report.cost.maxPROS ? `${report.cost.maxPROS} PROS` : "unknown"],
    ["node estimate", report.gas.nodeEstimate ? `${num(report.gas.nodeEstimate)} gas` : "—"],
    ["node vs measured", report.gas.nodeEstimateOverMeasuredPercent === null ? "—" : `${report.gas.nodeEstimateOverMeasuredPercent.toFixed(1)}%`],
    ["intrinsic floor", `${num(report.gas.intrinsic)} gas`],
    ["fee", `${gwei(report.fees.maxFeePerGas)} gwei max, ${gwei(report.fees.priorityFee)} gwei tip`],
    ["base fee", `${gwei(report.fees.baseFee)} gwei (${report.fees.source})`],
  ]);

  table($("funding"), [
    ["sender", report.account.address],
    ["balance", `${report.account.balancePROS} PROS (nonce ${report.account.nonce})`],
    ["required", `${report.funding.requiredPROS} PROS`],
    ["sufficient", report.funding.sufficient ? "yes" : `no — short by ${report.funding.shortfallPROS} PROS`, report.funding.sufficient ? "ok" : "bad"],
  ]);

  table($("target"), [
    ["address", report.target.address],
    ["kind", report.target.isContract ? `contract, ${num(report.target.codeSize)} bytes` : "externally owned account, no code"],
    ["token", report.token ? `${report.token.symbol || "unknown"} · ${report.token.decimals ?? "?"} decimals` : undefined],
    ["token balance", report.token?.balanceFormatted ?? undefined],
  ]);

  const deltas = $("deltas");
  deltas.replaceChildren();
  if (!report.intent.deltas?.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 2;
    td.className = "muted";
    td.textContent = "No balance or allowance change could be derived from this calldata.";
    tr.append(td);
    deltas.append(tr);
  } else {
    for (const d of report.intent.deltas) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.textContent = short(d.account);
      const td = document.createElement("td");
      const sign = String(d.change).startsWith("-") ? "" : "+";
      td.textContent = `${d.field} ${sign}${d.change}${d.spender ? ` for ${short(d.spender)}` : ""}`;
      tr.append(th, td);
      deltas.append(tr);
    }
  }

  $("blocking").replaceChildren(...report.blocking.map((b) => Object.assign(document.createElement("li"), { textContent: b })));
  $("not-measured").replaceChildren(...report.notMeasured.map((n) => Object.assign(document.createElement("li"), { textContent: n })));
  $("raw").textContent = JSON.stringify(report, null, 2);
  $("chain").textContent = `chain ${report.chain.id} · block ${num(report.chain.block)}`;
}

// Responses can arrive out of order when someone submits twice. Without this
// guard the slower, older response wins and the page shows a report for a
// transaction the fields no longer describe.
let requestSeq = 0;

async function submit(event) {
  event.preventDefault();
  const mine = ++requestSeq;
  const error = $("error");
  error.hidden = true;

  const body = { from: $("from").value.trim(), to: $("to").value.trim() };
  const data = $("data").value.trim();
  const value = $("value").value.trim();
  if (data) body.data = data;
  if (value) body.value = value;

  $("go").disabled = true;
  $("go").textContent = "Simulating…";
  try {
    const skip = $("fast").checked ? "?skipHistory=1" : "";
    const res = await fetch(`./api/simulate${skip}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json();
    if (mine !== requestSeq) return; // superseded by a newer submission
    if (!res.ok) {
      error.hidden = false;
      error.textContent = payload.field ? `${payload.error} (field: ${payload.field})` : payload.error || `HTTP ${res.status}`;
      $("result").hidden = true;
      return;
    }
    render(payload);
  } catch (err) {
    if (mine !== requestSeq) return;
    error.hidden = false;
    error.textContent = `request failed: ${err.message}`;
  } finally {
    if (mine === requestSeq) {
      $("go").disabled = false;
      $("go").textContent = "Simulate";
    }
  }
}

$("form").addEventListener("submit", submit);
