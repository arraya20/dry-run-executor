// Cloudflare Pages Function: POST /api/simulate
//
// The only thing this endpoint accepts is a transaction. Anything that looks
// like an answer the caller has already decided on is refused with 400 and the
// offending field is named, because the inherited version of this project took a
// `mockRevert` flag and reported whatever the caller wanted to hear.
//
// Environment:
//   PHAROS_RPC          optional override of the RPC endpoint
//   PHAROS_EXPECTED_CHAIN_ID  optional override of the chain guard

import { dryRun, RequestError, PHAROS } from "../../src/simulate.mjs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

export const onRequestPost = async ({ request, env }) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "body must be JSON", code: "bad-json" }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "body must be a JSON object", code: "bad-body" }, 400);
  }

  // Execution options live in the query string, not the body: the body describes
  // the transaction and nothing else. skipHistory only drops a corroborating
  // sample; it can never change the verdict.
  const skipHistory = new URL(request.url).searchParams.has("skipHistory");

  const rpcUrl = (env && env.PHAROS_RPC) || PHAROS.rpc;
  const chainId = env && env.PHAROS_EXPECTED_CHAIN_ID ? Number(env.PHAROS_EXPECTED_CHAIN_ID) : PHAROS.chainId;

  try {
    const report = await dryRun(body, { url: rpcUrl, chainId, fetchImpl: fetch, skipHistory });

    // If the node never answered the call, nothing was measured. Returning 200
    // with a report here would let a caller mistake an outage for a result.
    if (report.execution.status === "node-error" || report.execution.status === "transport-error") {
      return json(
        {
          error: "the node refused the simulation, so nothing was measured",
          detail: report.execution.detail,
          code: "upstream-failure",
          block: report.chain.block,
        },
        502,
      );
    }

    return json(report, 200);
  } catch (err) {
    if (err instanceof RequestError) {
      return json({ error: err.message, code: "rejected-request", field: err.field ?? null }, 400);
    }
    // Never turn an outage into a clean-looking result: say the node failed.
    return json({ error: "the node could not be reached or refused the call", detail: String(err?.message || err), code: "upstream-failure" }, 502);
  }
};

export const onRequestGet = async () =>
  json({ error: "POST a transaction to /api/simulate", code: "method-not-allowed" }, 405);

export const onRequest = async (context) => {
  if (context.request.method === "POST") return onRequestPost(context);
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ error: `method ${context.request.method} not allowed`, code: "method-not-allowed" }, 405);
};
