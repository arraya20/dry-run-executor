// Pre-Flight Transaction Simulator
export function simulateTransaction({ from, to, data = "0x", value = "0", gasPrice = "1000000000", mockRevert = null }) {
  if (mockRevert) {
    return {
      simulationStatus: "REVERT",
      willSucceed: false,
      revertReason: mockRevert,
      estimatedGas: null,
      estimatedCostWei: null
    };
  }

  // Base gas calculation: 21,000 intrinsic + calldata cost
  let calldataGas = 0n;
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  for (let i = 0; i < hex.length; i += 2) {
    const byte = hex.substr(i, 2);
    calldataGas += byte === "00" ? 4n : 16n;
  }

  const estimatedGas = 21000n + calldataGas + 35000n; // Execution buffer
  const gasPriceBn = BigInt(gasPrice);
  const estimatedCostWei = estimatedGas * gasPriceBn;

  return {
    simulationStatus: "SUCCESS",
    willSucceed: true,
    estimatedGas: estimatedGas.toString(),
    gasPriceWei: gasPriceBn.toString(),
    estimatedCostWei: estimatedCostWei.toString(),
    estimatedCostPROS: (Number(estimatedCostWei) / 1e18).toFixed(8)
  };
}
