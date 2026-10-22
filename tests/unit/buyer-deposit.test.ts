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
import { enoughForDeposit, replacementKind, sameIntent, sendStep, stepCall, waitForStep, type DepositAttempt } from "@/lib/buyer/deposit";
import { assertWallet, switchToArc, userRejected } from "@/lib/buyer/wallet";
import { BUYER, fakeWallet, HASH, SELLER } from "../helpers/buyer-fixtures";

afterEach(() => vi.useRealTimers());
const amount = BigInt(100000);
function attempt(step: DepositAttempt["step"] = "deposit") { return { context: fakeWallet().context, amount, step, hash: HASH }; }

describe("deposit intent and exact funds", () => {
  it("requires principal plus gas in native units", () => {
    const principal = amount * BigInt(10) ** BigInt(12);
    expect(enoughForDeposit(principal, amount, BigInt(1))).toBe(false);
    expect(enoughForDeposit(principal + BigInt(1), amount, BigInt(1))).toBe(true);
  });
  it.each(["approval", "deposit"] as const)("accepts only an unchanged repriced %s", step => {
    const value = attempt(step); const call = stepCall(step, amount);
    const transaction = { from: BUYER, to: call.to, value: call.value, input: call.data };
    expect(sameIntent(value, transaction)).toBe(true);
    expect(replacementKind(value, "repriced", transaction)).toBeUndefined();
    expect(replacementKind(value, "replaced", transaction)).toBe("replaced");
  });
  it("a successful cancellation receipt must not advance approval", () => {
    const value = attempt("approval");
    expect(replacementKind(value, "cancelled", { from: BUYER, to: BUYER, value: BigInt(0), input: "0x" })).toBe("cancelled");
  });
  it.each(["input", "to", "from", "value"])("rejects changed replacement %s even if reported as repriced", field => {
    const value = attempt(); const call = stepCall("deposit", amount);
    const transaction = { from: BUYER, to: call.to, value: call.value, input: call.data, [field]: field === "value" ? BigInt(1) : SELLER };
    expect(replacementKind(value, "repriced", transaction)).toBe("replaced");
  });
});

describe("wallet context boundaries", () => {
  it("validates live account/chain before a financial step", async () => {
    const wallet = fakeWallet(); await expect(assertWallet(wallet.context, () => true)).resolves.toBeUndefined();
    wallet.request.mockResolvedValue([SELLER]); await expect(assertWallet(wallet.context, () => true)).rejects.toThrow();
  });
  it("does not poll receipts on the wrong chain", async () => {
    vi.useFakeTimers(); const wallet = fakeWallet(); wallet.request.mockResolvedValue("0x1");
    const result = waitForStep({ ...attempt(), context: wallet.context }, () => true);
    await vi.advanceTimersByTimeAsync(15001);
    expect(await result).toEqual({ kind: "paused", hash: HASH });
    expect(wallet.request.mock.calls.every(([value]) => value.method === "eth_chainId")).toBe(true);
  });
  it("sends no further receipt RPC once its context has been invalidated", async () => {
    vi.useFakeTimers(); const wallet = fakeWallet();
    const result = waitForStep({ ...attempt(), context: wallet.context }, () => false);
    await vi.advanceTimersByTimeAsync(15001);
    expect(await result).toEqual({ kind: "paused", hash: HASH }); expect(wallet.request).not.toHaveBeenCalled();
  });
  it("discards a late successful receipt after context invalidation", async () => {
    vi.useFakeTimers(); const wallet = fakeWallet(); let current = true;
    const original = wallet.request.getMockImplementation()!;
    wallet.request.mockImplementation(async request => {
      if (request.method === "eth_getTransactionReceipt") { current = false; return "0x1"; }
      return original(request);
    });
    const result = waitForStep({ ...attempt(), context: wallet.context }, () => current);
    await vi.advanceTimersByTimeAsync(15001);
    expect(await result).toEqual({ kind: "paused", hash: HASH });
    expect(wallet.request.mock.calls.filter(([value]) => value.method === "eth_getTransactionReceipt")).toHaveLength(1);
  });
  it("treats only explicit rejection as rejection, including wrapped errors", () => {
    expect(userRejected({ cause: { code: 4001 } })).toBe(true);
    expect(userRejected({ code: 4900 })).toBe(false); expect(userRejected(new Error("lost response"))).toBe(false);
  });
  it("does not retry a provider submission accepted before its hash response was lost", async () => {
    const wallet = fakeWallet(); let accepted = false;
    const original = wallet.request.getMockImplementation()!;
    wallet.request.mockImplementation(async request => {
      if (request.method === "eth_sendTransaction") { accepted = true; throw new Error("Response lost after acceptance"); }
      return original(request);
    });
    const prepared = { ...stepCall("deposit", amount), gas: BigInt(100000), maxFeePerGas: BigInt(2), maxPriorityFeePerGas: BigInt(1), fee: BigInt(200000) };
    const result = await sendStep(wallet.context, prepared, () => true).catch(error => error);
    expect(accepted).toBe(true);
    expect(result).toBeInstanceOf(Error);
    expect(userRejected(result)).toBe(false);
    expect(wallet.request.mock.calls.filter(([value]) => value.method === "eth_sendTransaction")).toHaveLength(1);
  });
  it("adds Arc only on an explicit separate action", async () => {
    const wallet = fakeWallet(); wallet.request.mockResolvedValue("0x");
    await switchToArc(wallet.provider);
    expect(wallet.request).toHaveBeenCalledWith(expect.objectContaining({ method: "wallet_switchEthereumChain" }));
    expect(wallet.request).toHaveBeenCalledTimes(1);
    await switchToArc(wallet.provider, true);
    expect(wallet.request).toHaveBeenLastCalledWith(expect.objectContaining({ method: "wallet_addEthereumChain" }));
  });
});
