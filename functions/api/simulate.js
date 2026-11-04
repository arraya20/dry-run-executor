import { simulateTransaction } from "../../src/simulator.mjs";

export async function onRequestPost({ request }) {
  const body = await request.json();
  const simulation = simulateTransaction(body);
  return new Response(JSON.stringify({ success: true, simulation }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
