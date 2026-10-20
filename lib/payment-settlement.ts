/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { isAddress } from "viem";

export const SETTLEMENT_NETWORK = "eip155:5042002";

export interface SettlementSnapshot {
  paymentEventId: string;
  transferId: string;
  status: string;
  txHash: string | null;
  checkedAt: string;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function address(value: unknown): value is string {
  return typeof value === "string" && isAddress(value, { strict: false });
}

function atomic(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

export function paymentLookup(record: unknown, seller: string) {
  const row = object(record);
  const requirements = object(object(row?.raw)?.requirements);
  if (address(requirements?.payTo) && requirements.payTo.toLowerCase() !== seller.toLowerCase()) {
    return { error: "payment_not_found" } as const;
  }
  if (!row || !requirements || !isUuid(row.gateway_tx) ||
      row.network !== SETTLEMENT_NETWORK || requirements.network !== SETTLEMENT_NETWORK ||
      !address(requirements.payTo) || !address(row.payer) || !atomic(requirements.amount)) {
    return { error: "lookup_unavailable" } as const;
  }
  return { transferId: row.gateway_tx, seller, payer: row.payer, amount: requirements.amount };
}

export function transferSnapshot(
  value: unknown,
  expected: { transferId: string; seller: string; payer: string; amount: string },
  paymentEventId: string,
): SettlementSnapshot | null {
  const transfer = object(value);
  if (!transfer || typeof transfer.id !== "string" ||
      transfer.id.toLowerCase() !== expected.transferId.toLowerCase() || transfer.token !== "USDC" ||
      transfer.sendingNetwork !== SETTLEMENT_NETWORK || transfer.recipientNetwork !== SETTLEMENT_NETWORK ||
      !address(transfer.fromAddress) || transfer.fromAddress.toLowerCase() !== expected.payer.toLowerCase() ||
      !address(transfer.toAddress) || transfer.toAddress.toLowerCase() !== expected.seller.toLowerCase() ||
      !atomic(transfer.amount) || BigInt(transfer.amount) !== BigInt(expected.amount) ||
      typeof transfer.status !== "string" || !transfer.status.trim() || transfer.status.length > 64 ||
      !(transfer.txHash === null || (typeof transfer.txHash === "string" && /^0x[\da-f]{64}$/i.test(transfer.txHash)))) {
    return null;
  }
  return {
    paymentEventId, transferId: expected.transferId, status: transfer.status,
    txHash: transfer.txHash, checkedAt: new Date().toISOString(),
  };
}

export function settlementStatusLabel(status: string): string {
  switch (status) {
    case "received": return "Accepted by Gateway; awaiting batching";
    case "batched": return "Included in a batch for processing";
    case "confirmed": return "Confirmed onchain";
    case "completed": return "Completed by Gateway";
    case "failed": return "Gateway reports this transfer failed";
    default: return `Unrecognized Gateway status: ${status}`;
  }
}
