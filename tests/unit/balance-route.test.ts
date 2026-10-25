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
import { TEST_SESSION_SECRET, cookieStoreFor } from "../helpers/session";

const cookies = vi.hoisted(() => vi.fn());
const readContract = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ cookies }));
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: () => ({ readContract }),
}));

import { GET } from "@/app/api/gateway/balance/route";

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", TEST_SESSION_SECRET);
  vi.stubEnv("SELLER_ADDRESS", "0x" + "ab".repeat(20));
  readContract.mockResolvedValue(BigInt("2500000"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        balances: [{ domain: 26, balance: "1.5", withdrawing: "0.5", withdrawable: "1.0" }],
      }),
    })),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/gateway/balance", () => {
  it("does not disclose the seller's balances to a signed-out caller", async () => {
    cookies.mockResolvedValue(await cookieStoreFor(false));
    const res = await GET();
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
  });

  it("returns wallet and Gateway balances to the signed-in seller", async () => {
    cookies.mockResolvedValue(await cookieStoreFor(true));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      wallet: { balance: "2.5" },
      gateway: { total: "2.000000", available: "1.5", withdrawing: "0.5", withdrawable: "1.0" },
    });
  });

  it("reports a configuration error when SELLER_ADDRESS is missing", async () => {
    cookies.mockResolvedValue(await cookieStoreFor(true));
    vi.stubEnv("SELLER_ADDRESS", "");
    expect((await GET()).status).toBe(500);
  });
});
