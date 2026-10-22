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
import { NextRequest } from "next/server";
import { queryBuilder, queueTables } from "../helpers/supabase-mock";
import { TEST_SESSION_SECRET, cookieStoreFor } from "../helpers/session";

const db = vi.hoisted(() => ({ from: vi.fn() }));
const cookies = vi.hoisted(() => vi.fn());
const gateway = vi.hoisted(() => ({
  address: "0xSellerWallet",
  getBalances: vi.fn(),
  withdraw: vi.fn(),
}));
const GatewayClient = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ cookies }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
vi.mock("@circle-fin/x402-batching/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@circle-fin/x402-batching/client")>()),
  GatewayClient,
}));

import { POST } from "@/app/api/gateway/withdraw/route";

const DEST = "0x000000000000000000000000000000000000dEaD";

const call = (body: unknown, raw = false) =>
  POST(
    new NextRequest("http://localhost/api/gateway/withdraw", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  );

const funded = () =>
  gateway.getBalances.mockResolvedValue({
    wallet: { formatted: "0.5" },
    gateway: { formattedAvailable: "10.5" },
  });

beforeEach(() => {
  db.from.mockReset();
  gateway.getBalances.mockReset();
  gateway.withdraw.mockReset();
  GatewayClient.mockReset();
  GatewayClient.mockImplementation(function () {
    return gateway;
  });
  vi.stubEnv("SESSION_SECRET", TEST_SESSION_SECRET);
  vi.stubEnv("SELLER_PRIVATE_KEY", "0x" + "11".repeat(32));
  funded();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function signedIn(value: boolean) {
  const store = await cookieStoreFor(value);
  cookies.mockResolvedValue(store);
}

describe("POST /api/gateway/withdraw — access control", () => {
  it("refuses a signed-out caller before touching the wallet or database", async () => {
    await signedIn(false);
    const res = await call({ amount: "1", destinationChain: "arcTestnet", destinationAddress: DEST });
    expect(res.status).toBe(401);
    expect(GatewayClient).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("refuses everyone when SESSION_SECRET is not configured", async () => {
    await signedIn(true);
    vi.stubEnv("SESSION_SECRET", "");
    const res = await call({ amount: "1", destinationChain: "arcTestnet" });
    expect(res.status).toBe(401);
    expect(GatewayClient).not.toHaveBeenCalled();
  });
});

describe("POST /api/gateway/withdraw — input validation", () => {
  beforeEach(() => signedIn(true));

  it.each([
    ["missing", undefined],
    ["zero", "0"],
    ["negative", "-5"],
    ["exponent", "1e21"],
    ["too precise", "1.1234567"],
    ["not a number", "abc"],
    ["a number, not a string", 5],
  ])("rejects an amount that is %s", async (_name, amount) => {
    const res = await call({ amount, destinationChain: "arcTestnet" });
    expect(res.status).toBe(400);
    expect(GatewayClient).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "nope"])(
    "rejects unsupported chain %j (including Object.prototype keys)",
    async (destinationChain) => {
      const res = await call({ amount: "1", destinationChain });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Unsupported chain/);
      expect(GatewayClient).not.toHaveBeenCalled();
    },
  );

  it.each(["0x123", "not-an-address", 42, "0x" + "g".repeat(40)])(
    "rejects destination address %j",
    async (destinationAddress) => {
      const res = await call({ amount: "1", destinationChain: "arcTestnet", destinationAddress });
      expect(res.status).toBe(400);
      expect(db.from).not.toHaveBeenCalled();
    },
  );

  it("rejects a body that is not JSON", async () => {
    expect((await call("not json", true)).status).toBe(400);
  });
});

describe("POST /api/gateway/withdraw — behaviour", () => {
  beforeEach(() => signedIn(true));

  it("refuses to withdraw more than the Gateway balance, exactly", async () => {
    gateway.getBalances.mockResolvedValue({
      wallet: { formatted: "0.5" },
      gateway: { formattedAvailable: "10.500000" },
    });
    const res = await call({ amount: "10.500001", destinationChain: "arcTestnet" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Insufficient gateway balance/);
    expect(gateway.withdraw).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("allows withdrawing exactly the available balance", async () => {
    const insert = queryBuilder({ data: { id: "w1" } });
    const update = queryBuilder({});
    queueTables(db, { withdrawals: [insert, update] });
    gateway.withdraw.mockResolvedValue({
      mintTxHash: "0xabc", formattedAmount: "10.5",
      sourceChain: "arcTestnet", destinationChain: "arcTestnet", recipient: DEST,
    });
    const res = await call({ amount: "10.5", destinationChain: "arcTestnet" });
    expect(res.status).toBe(200);
  });

  it("records the withdrawal, sends it, then marks it confirmed", async () => {
    const insert = queryBuilder({ data: { id: "w1" } });
    const update = queryBuilder({});
    queueTables(db, { withdrawals: [insert, update] });
    gateway.withdraw.mockResolvedValue({
      mintTxHash: "0xabc",
      formattedAmount: "2.5",
      sourceChain: "arcTestnet",
      destinationChain: "arcTestnet",
      recipient: DEST,
    });

    const res = await call({ amount: ".5", destinationChain: "arcTestnet", destinationAddress: DEST });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ id: "w1", txHash: "0xabc", status: "confirmed" });
    expect(insert.insert.mock.calls[0][0]).toMatchObject({
      amount_usdc: "0.5", // normalized
      destination_chain: "arcTestnet",
      destination_address: DEST,
      status: "submitted",
    });
    expect(gateway.withdraw).toHaveBeenCalledWith("0.5", {
      chain: "arcTestnet",
      recipient: DEST,
    });
    expect(update.update).toHaveBeenCalledWith({ status: "confirmed", tx_hash: "0xabc" });
  });

  it("marks the withdrawal failed and returns a friendly gas message", async () => {
    const insert = queryBuilder({ data: { id: "w1" } });
    const update = queryBuilder({});
    queueTables(db, { withdrawals: [insert, update] });
    gateway.withdraw.mockRejectedValue(new Error("insufficient funds for gas * price + value"));

    const res = await call({ amount: "1", destinationChain: "arcTestnet" });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/insufficient native tokens/);
    expect(update.update).toHaveBeenCalledWith({ status: "failed" });
  });

  it("still reports success if the funds moved but the row could not be confirmed", async () => {
    const insert = queryBuilder({ data: { id: "w1" } });
    const update = queryBuilder({ error: { message: "db down" } });
    queueTables(db, { withdrawals: [insert, update] });
    gateway.withdraw.mockResolvedValue({
      mintTxHash: "0xabc", formattedAmount: "1",
      sourceChain: "arcTestnet", destinationChain: "arcTestnet", recipient: DEST,
    });
    const res = await call({ amount: "1", destinationChain: "arcTestnet" });
    expect(res.status).toBe(200);
  });

  it("does not move funds if the withdrawal cannot be recorded first", async () => {
    queueTables(db, { withdrawals: [queryBuilder({ error: { message: "db down" } })] });
    const res = await call({ amount: "1", destinationChain: "arcTestnet" });
    expect(res.status).toBe(500);
    expect(gateway.withdraw).not.toHaveBeenCalled();
  });
});
