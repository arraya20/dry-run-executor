import assert from "node:assert";
import { simulateTransaction } from "../src/simulator.mjs";

console.log("Running Dry-Run Executor tests...");

// Test 1: Successful Simulation
const sim = simulateTransaction({
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  data: "0xa9059cbb00000000000000000000000033333333333333333333333333333333333333330000000000000000000000000000000000000000000000000de0b6b3a7640000"
});
assert.strictEqual(sim.willSucceed, true);
assert.strictEqual(BigInt(sim.estimatedGas) > 21000n, true);

// Test 2: Revert Prediction
const rev = simulateTransaction({
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  mockRevert: "ERC20: transfer amount exceeds balance"
});
assert.strictEqual(rev.willSucceed, false);
assert.strictEqual(rev.revertReason, "ERC20: transfer amount exceeds balance");

console.log("✅ All Dry-Run Executor tests passed successfully!");
