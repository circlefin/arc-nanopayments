/** Copyright 2026 Circle Internet Group, Inc. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { isUuid, paymentLookup, settlementStatusLabel, transferSnapshot } from "@/lib/payment-settlement";
import { ATOMIC, EVENT_ID, HASH, PAYER, SELLER, TRANSFER_ID, paymentFixture, transferFixture } from "../helpers/settlement-fixtures";

const expected = { transferId: TRANSFER_ID, seller: SELLER, payer: PAYER, amount: ATOMIC };

describe("payment settlement association", () => {
  it("accepts general UUIDs and the existing stored payment metadata", () => {
    expect(isUuid(TRANSFER_ID)).toBe(true);
    expect(paymentLookup(paymentFixture(), SELLER)).toEqual(expected);
    expect(paymentLookup(paymentFixture(), SELLER.toUpperCase().replace("0X", "0x"))).toEqual({ ...expected, seller: SELLER.toUpperCase().replace("0X", "0x") });
  });

  it.each([null, "", HASH, "bad-id"])("does not guess a transfer from reference %s", gateway_tx => {
    expect(paymentLookup({ ...paymentFixture(), gateway_tx }, SELLER)).toEqual({ error: "lookup_unavailable" });
  });

  it.each([
    { raw: null }, { raw: { requirements: { payTo: SELLER } } },
    { payer: "unknown" }, { payer: null }, { network: "eip155:1" },
    { raw: { requirements: { ...paymentFixture().raw.requirements, amount: "1.0" } } },
  ])("keeps unsupported records inspectable without allowing lookup: %j", fields => {
    expect(paymentLookup({ ...paymentFixture(), ...fields }, SELLER)).toEqual({ error: "lookup_unavailable" });
  });

  it("rejects a stored payment belonging to another seller", () => {
    expect(paymentLookup(paymentFixture(), PAYER)).toEqual({ error: "payment_not_found" });
  });

  it.each(["received", "batched", "confirmed", "completed", "failed", "new_future_state"])("accepts a %s snapshot without requiring unused fields", status => {
    expect(transferSnapshot({ ...transferFixture(), status, extra: "ignored" }, expected, EVENT_ID))
      .toMatchObject({ paymentEventId: EVENT_ID, transferId: TRANSFER_ID, status, txHash: null });
    expect(settlementStatusLabel(status)).toBeTruthy();
  });

  it("does not equate a batch hash with confirmation and tolerates address case and leading zeros", () => {
    const result = transferSnapshot({ ...transferFixture(), status: "batched", txHash: HASH,
      amount: "00" + ATOMIC, toAddress: SELLER.toUpperCase().replace("0X", "0x"), id: TRANSFER_ID.toUpperCase() }, expected, EVENT_ID);
    expect(result).toMatchObject({ status: "batched", txHash: HASH });
    expect(settlementStatusLabel("batched")).toBe("Included in a batch for processing");
  });

  it.each([
    { id: EVENT_ID }, { token: "ETH" }, { sendingNetwork: "eip155:1" }, { recipientNetwork: "eip155:1" },
    { fromAddress: SELLER }, { toAddress: PAYER }, { amount: "9007199254740992" }, { amount: 1 },
    { status: "" }, { status: " ", txHash: null }, { status: "x".repeat(65) },
    { txHash: undefined }, { txHash: "0x123" }, { txHash: { hash: HASH } },
  ])("rejects mismatched or malformed consumed fields: %j", fields => {
    expect(transferSnapshot({ ...transferFixture(), ...fields }, expected, EVENT_ID)).toBeNull();
  });

  it.each([null, [], "text"])("rejects a non-object transfer: %j", value => {
    expect(transferSnapshot(value, expected, EVENT_ID)).toBeNull();
  });
});
