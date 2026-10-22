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
import { acknowledgement, getPrice, signQuote, submitPurchase, validateChallenge } from "@/lib/buyer/protocol";
import { boundedText, decodeHeader, encodeHeader, MAX_BODY } from "@/lib/buyer/http";
import { publicBuyerConfig, usdcAtomic, usdcDisplay } from "@/lib/buyer/network";
import { resourceBody, resources } from "@/lib/buyer/resources";
import { ack, BUYER, challenge, fakeWallet, REFERENCE, SELLER } from "../helpers/buyer-fixtures";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const quote = () => ({ resource: resources[0], ...validateChallenge(encodeHeader(challenge()), resources[0], SELLER), createdAt: Date.now() });

describe("buyer amount and transport boundaries", () => {
  it.each(["0", "1", "1.000001", "9007199254740993.123456"])("normalizes %s exactly", value => {
    expect(usdcAtomic(usdcDisplay(usdcAtomic(value)))).toBe(usdcAtomic(value));
  });
  it.each(["-1", "0.0000001", "1e3", " 1", "1.", "", "NaN"])("rejects invalid decimal %s", value => expect(() => usdcAtomic(value)).toThrow());
  it("separates valid zero balance from a positive funding amount", () => {
    expect(usdcAtomic("0")).toBe(BigInt(0)); expect(() => usdcAtomic("0", true)).toThrow();
  });
  it("passes only a validated public seller address", () => {
    expect(publicBuyerConfig(SELLER)).toEqual({ sellerAddress: SELLER });
    for (const value of [undefined, "invalid", `0x${"0".repeat(40)}`]) expect(publicBuyerConfig(value)).toEqual({ sellerAddress: null });
  });
  it("preserves UTF-8 without a Buffer polyfill", () => expect(decodeHeader(encodeHeader({ text: "☀ 你好" }))).toEqual({ text: "☀ 你好" }));
  it.each([null, "!", "a".repeat(16385), "e30===", "e2JhZA=="])("rejects malformed headers", value => expect(() => decodeHeader(value)).toThrow());
  it("bounds the actual response stream", async () => {
    await expect(boundedText(new Response("x".repeat(MAX_BODY + 1)))).rejects.toThrow("64 KiB");
  });
  it("freezes POST bytes and enforces the compute input limit", () => {
    expect(resourceBody(resources[2], "hi ☀")).toBe('{"text":"hi ☀"}');
    expect(resourceBody(resources[0], "ignored")).toBeUndefined();
    expect(() => resourceBody(resources[2], "x".repeat(2001))).toThrow();
  });
});

describe("challenge validation and actual SDK signer", () => {
  it("accepts the configured exact challenge", () => expect(quote().requirements.amount).toBe("1000"));
  it.each(["network", "asset", "payTo", "amount", "scheme"] as const)("rejects a changed %s before signing", field => {
    const data = challenge(); data.accepts[0][field] = "invalid";
    expect(() => validateChallenge(encodeHeader(data), resources[0], SELLER)).toThrow();
  });
  it.each([0, -1, NaN, 604901])("rejects invalid validity %s", value => {
    const data = challenge(); data.accepts[0].maxTimeoutSeconds = value;
    expect(() => validateChallenge(encodeHeader(data), resources[0], SELLER)).toThrow();
  });
  it("rejects the wrong verifying contract and resource", () => {
    const data = challenge(); data.accepts[0].extra.verifyingContract = BUYER;
    expect(() => validateChallenge(encodeHeader(data), resources[0], SELLER)).toThrow();
    expect(() => validateChallenge(encodeHeader(challenge()), resources[1], SELLER)).toThrow();
  });
  it("uses the released SDK and injected typed-data signer with accepted/resource metadata", async () => {
    const wallet = fakeWallet();
    const value = decodeHeader(await signQuote(quote(), wallet.context, () => true));
    expect(value).toMatchObject({ x402Version: 2, accepted: { amount: "1000", payTo: SELLER }, resource: { url: resources[0].path }, payload: { authorization: { from: BUYER, value: "1000" } } });
    expect(wallet.request.mock.calls.some(([request]) => request.method === "eth_signTypedData_v4")).toBe(true);
  });
  it("never signs an expired quote or a changed context", async () => {
    const wallet = fakeWallet();
    await expect(signQuote({ ...quote(), createdAt: 0 }, wallet.context, () => true)).rejects.toThrow("60 seconds");
    await expect(signQuote(quote(), wallet.context, () => false)).rejects.toThrow();
    expect(wallet.request).not.toHaveBeenCalled();
  });
  it("discards a late signature if the wallet changes", async () => {
    const wallet = fakeWallet(); let current = true;
    const original = wallet.request.getMockImplementation()!;
    wallet.request.mockImplementation(async request => {
      const result = await original(request);
      if (request.method === "eth_signTypedData_v4") current = false;
      return result;
    });
    await expect(signQuote(quote(), wallet.context, () => current)).rejects.toThrow();
  });
});

describe("HTTP/payment outcomes", () => {
  it("gets a price using fixed method/body, no credentials and no redirects", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodeHeader(challenge()) } }));
    vi.stubGlobal("fetch", fetch);
    expect(await getPrice(resources[0], undefined, SELLER, new AbortController().signal)).toHaveProperty("requirements.amount", "1000");
    expect(fetch).toHaveBeenCalledWith(resources[0].path, expect.objectContaining({ method: "GET", credentials: "omit", cache: "no-store", redirect: "error" }));
  });
  it("shows an unpaywalled resource without signing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("free")));
    expect(await getPrice(resources[0], undefined, SELLER, new AbortController().signal)).toMatchObject({ payment: "unpaywalled", text: "free" });
  });
  it.each([200, 500])("preserves valid acknowledgement on HTTP %s", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("resource", { status, headers: { "PAYMENT-RESPONSE": encodeHeader(ack()) } })));
    expect(await submitPurchase(quote(), "dummy", BUYER, new AbortController().signal)).toMatchObject({ payment: "acknowledged", reference: REFERENCE, status });
  });
  it("retains acceptance even when reading the resource fails", async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error("lost body")); } }), { headers: { "PAYMENT-RESPONSE": encodeHeader(ack()) } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await submitPurchase(quote(), "dummy", BUYER, new AbortController().signal)).toMatchObject({ payment: "acknowledged", reference: REFERENCE, text: "" });
  });
  it.each(["missing", "malformed", "payer", "network", "transaction", "success"])("does not acknowledge a %s response", async field => {
    const value = { ...ack(), [field]: "invalid" };
    const header: Record<string, string> = field === "missing" ? {} : { "PAYMENT-RESPONSE": field === "malformed" ? "!" : encodeHeader(value) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("resource", { headers: header })));
    const result = await submitPurchase(quote(), "dummy", BUYER, new AbortController().signal);
    expect(result).toMatchObject({ text: "resource", payment: "unknown" });
    expect(acknowledgement(new Response(null, { headers: header }), BUYER)).toBeUndefined();
  });
  it("never retries an interrupted paid request", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connection lost")); vi.stubGlobal("fetch", fetch);
    expect(await submitPurchase(quote(), "dummy", BUYER, new AbortController().signal)).toMatchObject({ payment: "unknown", status: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
