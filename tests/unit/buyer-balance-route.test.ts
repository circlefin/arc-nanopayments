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

import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/buyer/balance/route";
import { BUYER } from "../helpers/buyer-fixtures";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const request = (query = `address=${BUYER}`) => new NextRequest(`http://localhost/api/buyer/balance?${query}`);
const upstream = (balance: unknown = "1") => ({ balances: [{ domain: 26, balance }] });

describe("public buyer Gateway balance", () => {
  it.each(["0", "1", "1.000001", "9007199254740993.123456"])("normalizes decimal %s without ambiguity", async value => {
    const fetch = vi.fn().mockResolvedValue(Response.json(upstream(value))); vi.stubGlobal("fetch", fetch);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result.address).toBe(BUYER); expect(typeof result.availableAtomic).toBe("string");
    expect(fetch).toHaveBeenCalledWith("https://gateway-api-testnet.circle.com/v1/balances", expect.objectContaining({ redirect: "error", cache: "no-store", method: "POST", body: JSON.stringify({ token: "USDC", sources: [{ domain: 26, depositor: BUYER }] }) }));
  });
  it.each(["", "address=bad", `address=${BUYER}&address=${BUYER}`, `address=${BUYER}&url=https://example.com`, `address=${BUYER}&chain=1`])("rejects caller-controlled extra parameters", async query => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await GET(request(query))).status).toBe(400); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    {}, { balances: [] }, { balances: [{ domain: 1, balance: "1" }] }, upstream(100), upstream("-1"), upstream("0.0000001"),
    { token: "ETH", ...upstream() }, { balances: [{ domain: 26, balance: "1", depositor: `0x${"ab".repeat(20)}` }] },
    { balances: [{ domain: 26, balance: "1" }, { domain: 26, balance: "2" }] },
  ])("does not fabricate zero on an invalid upstream body", async data => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
    const response = await GET(request()); expect(response.status).toBe(502);
    expect(await response.json()).not.toHaveProperty("available");
  });
  it("does not retry upstream failures or reveal upstream content", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("upstream diagnostic", { status: 500 })); vi.stubGlobal("fetch", fetch);
    const response = await GET(request()); expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("upstream diagnostic"); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps the deadline active while streaming the body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener("abort", () => controller.error(new Error("aborted")));
    } }))));
    const response = GET(request()); await vi.advanceTimersByTimeAsync(5001);
    expect((await response).status).toBe(502);
  });
});
