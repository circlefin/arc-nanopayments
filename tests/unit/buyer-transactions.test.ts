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
import { prepareStep, sendStep, stepCall, waitForStep, type DepositAttempt } from "@/lib/buyer/deposit";
import { assertWallet, readProvider, userRejected, WALLET_READ_TIMEOUT_MS } from "@/lib/buyer/wallet";
import { BUYER, HASH, SELLER } from "../helpers/buyer-fixtures";
import { buyerProvider, CHAIN_HEX, FUNDING_AMOUNT, REPLACEMENT_HASH, rpcBlock, rpcReceipt, rpcTransaction } from "../helpers/buyer-provider";

beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Network disabled in wallet regressions")))));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const prepared = () => ({ ...stepCall("deposit", FUNDING_AMOUNT), gas: BigInt(100000), maxFeePerGas: BigInt(2), maxPriorityFeePerGas: BigInt(1), fee: BigInt(200000) });
const financialCalls = (wallet: ReturnType<typeof buyerProvider>) => wallet.request.mock.calls.filter(([value]) => ["eth_sendTransaction", "wallet_sendTransaction"].includes(value.method));

describe("actual viem transaction dispatch", () => {
  it.each(["accountsChanged", "chainChanged", "disconnect"])("does not dispatch after %s during viem's own chain read", async event => {
    const wallet = buyerProvider(); let current = true; let reads = 0;
    wallet.handlers.set("eth_chainId", () => {
      if (++reads === 2) {
        wallet.emit(event, event === "accountsChanged" ? [SELLER] : "0x1"); current = false;
      }
      return CHAIN_HEX; // A stale reply from viem's in-flight chain read.
    });
    const dispatched = vi.fn();
    await expect(sendStep(wallet.context, prepared(), () => current, dispatched)).rejects.toThrow();
    expect(reads).toBe(2); expect(financialCalls(wallet)).toHaveLength(0); expect(dispatched).not.toHaveBeenCalled();
  });
  it.each([-32000, -32602, -32601, 4200, -32004])("blocks viem's second financial request after provider error %s", async code => {
    const wallet = buyerProvider(); let accepted = false;
    wallet.handlers.set("eth_sendTransaction", () => { accepted = true; throw { code, message: "Submission response lost" }; });
    const dispatched = vi.fn();
    const result = await sendStep(wallet.context, prepared(), () => true, dispatched).catch(error => error);
    expect(accepted).toBe(true); expect(result).toBeInstanceOf(Error); expect(userRejected(result)).toBe(false);
    expect(financialCalls(wallet).map(([value]) => value.method)).toEqual(["eth_sendTransaction"]);
    expect(dispatched).toHaveBeenCalledTimes(1);
  });
  it("preserves explicit wallet rejection without a fallback", async () => {
    const wallet = buyerProvider(); wallet.handlers.set("eth_sendTransaction", () => { throw { code: 4001, message: "User rejected" }; });
    const result = await sendStep(wallet.context, prepared(), () => true).catch(error => error);
    expect(userRejected(result)).toBe(true); expect(financialCalls(wallet)).toHaveLength(1);
  });
  it("does not mark a definite pre-dispatch failure as a submission", async () => {
    const wallet = buyerProvider(); const dispatched = vi.fn();
    await expect(sendStep(wallet.context, prepared(), () => false, dispatched)).rejects.toThrow();
    expect(dispatched).not.toHaveBeenCalled(); expect(wallet.request).not.toHaveBeenCalled();
  });
  it("keeps the original hash if context changes after actual dispatch", async () => {
    const wallet = buyerProvider(); let current = true;
    wallet.handlers.set("eth_sendTransaction", () => { current = false; return HASH; });
    await expect(sendStep(wallet.context, prepared(), () => current)).resolves.toBe(HASH);
    expect(financialCalls(wallet)).toHaveLength(1);
  });
  it("does not time out or retry a pending submission prompt", async () => {
    const wallet = buyerProvider(); let resolve: (value: string) => void = () => {};
    wallet.handlers.set("eth_sendTransaction", () => new Promise(done => { resolve = done; }));
    let settled = false;
    const submission = sendStep(wallet.context, prepared(), () => true).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(financialCalls(wallet)).toHaveLength(1));
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(30000);
    expect(settled).toBe(false); expect(financialCalls(wallet)).toHaveLength(1);
    resolve(HASH); await expect(submission).resolves.toBe(HASH);
  });
});

describe("actual viem receipt replacement recovery", () => {
  it.each(["approval", "deposit"] as const)("retains cancellation/different replacement evidence across paused %s recovery", async step => {
    for (const kind of ["cancelled", "replaced"] as const) {
      vi.useFakeTimers(); const wallet = buyerProvider(); let replacementRead = false; let postReceiptReads = 0;
      wallet.handlers.set("eth_chainId", () => replacementRead && ++postReceiptReads === 2 ? "0x1" : CHAIN_HEX);
      wallet.handlers.set("eth_getTransactionReceipt", params => {
        if ((params as string[])[0] === HASH) return null;
        replacementRead = true; return rpcReceipt(REPLACEMENT_HASH);
      });
      wallet.handlers.set("eth_getTransactionByHash", () => rpcTransaction(HASH, stepCall(step, FUNDING_AMOUNT)));
      const replacement = { ...rpcTransaction(REPLACEMENT_HASH), to: kind === "cancelled" ? BUYER : SELLER, input: "0x" };
      wallet.handlers.set("eth_getBlockByNumber", () => rpcBlock([replacement]));
      const attempt: DepositAttempt = { context: wallet.context, step, amount: FUNDING_AMOUNT, hash: HASH };
      const waiting = waitForStep(attempt, () => true);
      await vi.advanceTimersByTimeAsync(100);
      const first = await waiting;
      expect(first).toMatchObject({ kind, hash: REPLACEMENT_HASH, replacement: kind });
      const calls = wallet.request.mock.calls.length;
      // The exact data the panel retains remains terminal even on a later check.
      const second = await waitForStep({ ...attempt, hash: first.hash, replacement: first.replacement }, () => true);
      expect(second.kind).toBe(kind); expect(wallet.request.mock.calls.length).toBe(calls);
      vi.useRealTimers();
    }
  });
  it("still confirms an unchanged repriced deposit", async () => {
    vi.useFakeTimers(); const wallet = buyerProvider();
    wallet.handlers.set("eth_getTransactionReceipt", params => (params as string[])[0] === HASH ? null : rpcReceipt(REPLACEMENT_HASH));
    wallet.handlers.set("eth_getBlockByNumber", () => rpcBlock([rpcTransaction(REPLACEMENT_HASH)]));
    const result = waitForStep({ context: wallet.context, step: "deposit", amount: FUNDING_AMOUNT, hash: HASH }, () => true);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ kind: "confirmed", hash: REPLACEMENT_HASH });
  });
  it("does not turn a reverted receipt into confirmation", async () => {
    const wallet = buyerProvider(); wallet.handlers.set("eth_getTransactionReceipt", () => rpcReceipt(HASH, "0x0"));
    expect(await waitForStep({ context: wallet.context, step: "deposit", amount: FUNDING_AMOUNT, hash: HASH }, () => true)).toEqual({ kind: "reverted", hash: HASH });
  });
});

describe("actual wallet reads and preflight", () => {
  it.each(["eth_accounts", "eth_chainId"])("bounds a hanging %s validation read", async method => {
    vi.useFakeTimers(); const wallet = buyerProvider(); wallet.handlers.set(method, () => new Promise(() => {}));
    const result = assertWallet(wallet.context, () => true).catch(error => error);
    await vi.advanceTimersByTimeAsync(WALLET_READ_TIMEOUT_MS + 1);
    expect(await result).toMatchObject({ message: expect.stringContaining("timed out") });
    expect(financialCalls(wallet)).toHaveLength(0);
  });
  it("ends an obsolete read on context invalidation and discards its late response", async () => {
    vi.useFakeTimers(); const wallet = buyerProvider(); let current = true; let resolve: (value: string) => void = () => {};
    wallet.handlers.set("eth_getBalance", () => new Promise(done => { resolve = done; }));
    const read = readProvider(wallet.provider, () => current).request({ method: "eth_getBalance", params: [BUYER, "latest"] }).catch(error => error);
    await vi.advanceTimersByTimeAsync(1); current = false; await vi.advanceTimersByTimeAsync(100);
    expect(await read).toMatchObject({ message: expect.stringContaining("context changed") });
    resolve("0xffff"); await vi.advanceTimersByTimeAsync(1);
    expect(await read).toBeInstanceOf(Error);
  });
  it("never routes a wallet prompt through the read deadline helper", () => {
    const wallet = buyerProvider();
    expect(() => readProvider(wallet.provider).request({ method: "eth_requestAccounts" })).toThrow("Only read-only");
    expect(wallet.request).not.toHaveBeenCalled();
  });
  it("uses actual allowance, simulation and fee reads before an exact deposit", async () => {
    const wallet = buyerProvider();
    expect(await prepareStep(wallet.context, "approval", FUNDING_AMOUNT, () => true)).toBeNull();
    const value = await prepareStep(wallet.context, "deposit", FUNDING_AMOUNT, () => true);
    expect(value).toMatchObject(stepCall("deposit", FUNDING_AMOUNT));
    expect(value!.gas).toBe(BigInt(120000)); expect(value!.fee > BigInt(0)).toBe(true);
    wallet.state.balance = FUNDING_AMOUNT * BigInt(10) ** BigInt(12);
    await expect(prepareStep(wallet.context, "deposit", FUNDING_AMOUNT, () => true)).rejects.toThrow("estimated gas");
    expect(financialCalls(wallet)).toHaveLength(0);
  });
});
