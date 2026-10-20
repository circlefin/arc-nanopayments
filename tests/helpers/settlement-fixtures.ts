/** Copyright 2026 Circle Internet Group, Inc. SPDX-License-Identifier: Apache-2.0 */
import { SETTLEMENT_NETWORK } from "@/lib/payment-settlement";

export const EVENT_ID = "11111111-1111-4111-8111-111111111111";
// UUID version 7 deliberately exercises the API's general UUID contract.
export const TRANSFER_ID = "22222222-2222-7222-8222-222222222222";
export const SELLER = "0x" + "ab".repeat(20);
export const PAYER = "0x" + "cd".repeat(20);
export const HASH = "0x" + "ef".repeat(32);
export const ATOMIC = "9007199254740993";

export function paymentFixture() {
  return {
    id: EVENT_ID, gateway_tx: TRANSFER_ID, network: SETTLEMENT_NETWORK,
    payer: PAYER, endpoint: "/api/premium/quote", amount_usdc: "9007199254.740993",
    created_at: "2026-10-20T12:00:00.000Z",
    raw: { requirements: { payTo: SELLER, amount: ATOMIC, network: SETTLEMENT_NETWORK } },
  };
}

export function transferFixture() {
  return {
    id: TRANSFER_ID, token: "USDC", status: "received",
    sendingNetwork: SETTLEMENT_NETWORK, recipientNetwork: SETTLEMENT_NETWORK,
    fromAddress: PAYER, toAddress: SELLER, amount: ATOMIC, txHash: null as string | null,
  };
}

export function snapshotFixture(status = "received", txHash: string | null = null) {
  return { paymentEventId: EVENT_ID, transferId: TRANSFER_ID, status, txHash, checkedAt: "2026-10-20T12:01:00.000Z" };
}
