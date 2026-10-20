/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { queryBuilder, queueTables } from "../helpers/supabase-mock";

const db = vi.hoisted(() => ({ from: vi.fn() }));
const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
vi.mock("@circle-fin/x402-batching/server", () => ({
  BatchFacilitatorClient: function () {
    return facilitator;
  },
}));

import { withGateway } from "@/lib/x402";

const SELLER = "0x" + "ab".repeat(20);
const PAYER = "0x" + "cd".repeat(20);

const paidRequest = (payload: object = { x402Version: 2, payload: {} }) =>
  new NextRequest("http://localhost/api/premium/quote", {
    headers: {
      "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
  });

const handler = vi.fn(async () => NextResponse.json({ secret: "premium content" }));
const route = () => withGateway(handler, "$0.03", "/api/premium/quote");

beforeEach(() => {
  db.from.mockReset();
  handler.mockClear();
  facilitator.verify.mockReset();
  facilitator.settle.mockReset();
  vi.stubEnv("SELLER_ADDRESS", SELLER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("withGateway", () => {
  it("answers 402 with payment requirements when there is no payment", async () => {
    const res = await route()(new NextRequest("http://localhost/api/premium/quote"));
    expect(res.status).toBe(402);

    const required = JSON.parse(
      Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString(),
    );
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:5042002",
      payTo: SELLER,
      amount: "30000", // $0.03 in 6-decimal USDC
    });
    expect(handler).not.toHaveBeenCalled();
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("does not run the handler when verification fails", async () => {
    facilitator.verify.mockResolvedValue({ isValid: false, invalidReason: "bad_signature" });
    const res = await route()(paidRequest());
    expect(res.status).toBe(402);
    expect((await res.json()).reason).toBe("bad_signature");
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not run the handler when settlement fails", async () => {
    facilitator.verify.mockResolvedValue({ isValid: true, payer: PAYER });
    facilitator.settle.mockResolvedValue({ success: false, errorReason: "insufficient_balance" });
    const res = await route()(paidRequest());
    expect(res.status).toBe(402);
    expect(handler).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("verifies against OUR requirements, not the ones the buyer claims", async () => {
    facilitator.verify.mockResolvedValue({ isValid: false });
    await route()(
      paidRequest({
        x402Version: 2,
        accepted: { payTo: PAYER, amount: "1" },
        payload: {},
      }),
    );
    expect(facilitator.verify.mock.calls[0][1]).toMatchObject({
      payTo: SELLER,
      amount: "30000",
    });
  });

  it("settles, records the payment, then serves the content", async () => {
    const insert = queryBuilder({});
    queueTables(db, { payment_events: [insert] });
    facilitator.verify.mockResolvedValue({ isValid: true, payer: PAYER });
    facilitator.settle.mockResolvedValue({ success: true, payer: PAYER, transaction: "tx-1" });

    const res = await route()(paidRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ secret: "premium content" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(insert.insert.mock.calls[0][0]).toMatchObject({
      endpoint: "/api/premium/quote",
      payer: PAYER,
      amount_usdc: "0.03",
      gateway_tx: "tx-1",
    });
    const settled = JSON.parse(
      Buffer.from(res.headers.get("PAYMENT-RESPONSE")!, "base64").toString(),
    );
    expect(settled).toMatchObject({ success: true, transaction: "tx-1", payer: PAYER });
  });

  it("still serves the content if recording the payment event fails", async () => {
    queueTables(db, { payment_events: [queryBuilder({ error: { message: "db down" } })] });
    facilitator.verify.mockResolvedValue({ isValid: true, payer: PAYER });
    facilitator.settle.mockResolvedValue({ success: true, payer: PAYER, transaction: "tx-1" });
    expect((await route()(paidRequest())).status).toBe(200);
  });

  it("answers 500 for a payment header that is not valid base64 JSON", async () => {
    const res = await route()(
      new NextRequest("http://localhost/api/premium/quote", {
        headers: { "payment-signature": "%%%not-base64-json%%%" },
      }),
    );
    expect(res.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", ""],
    ["malformed", "0x123"],
    ["undefined-like", "undefined"],
  ])("refuses to quote a payment when SELLER_ADDRESS is %s", async (_name, value) => {
    vi.stubEnv("SELLER_ADDRESS", value);
    const res = await route()(new NextRequest("http://localhost/api/premium/quote"));
    expect(res.status).toBe(500);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(facilitator.verify).not.toHaveBeenCalled();
  });
});
