type GatewayAmounts = {
  available: string;
  withdrawing: string;
  withdrawable: string;
};

function toAtomic(value: string): bigint {
  // Gateway returns decimal USDC strings, including whole amounts such as "1".
  const match = typeof value === "string" && /^(\d+)(?:\.(\d+))?$/.exec(value);
  const fraction = match ? (match[2] ?? "") : "";
  if (!match || match[0] !== value || /[1-9]/.test(fraction.slice(6))) {
    throw new Error("Invalid Gateway USDC amount");
  }
  // Extra trailing zeros are exact; nonzero sub-atomic digits are rejected.
  return (
    BigInt(match[1]) * BigInt(1_000_000) +
    BigInt(fraction.slice(0, 6).padEnd(6, "0"))
  );
}

function formatAtomic(value: bigint, fixed = false): string {
  const digits = value.toString().padStart(7, "0");
  const fraction = fixed ? digits.slice(-6) : digits.slice(-6).replace(/0+$/, "");
  return digits.slice(0, -6) + (fraction ? `.${fraction}` : "");
}

export function normalizeGatewayBalances(amounts: GatewayAmounts) {
  const available = toAtomic(amounts.available);
  const withdrawing = toAtomic(amounts.withdrawing);
  const withdrawable = toAtomic(amounts.withdrawable);
  return {
    total: formatAtomic(available + withdrawing, true),
    available: formatAtomic(available),
    withdrawing: formatAtomic(withdrawing),
    withdrawable: formatAtomic(withdrawable),
  };
}
