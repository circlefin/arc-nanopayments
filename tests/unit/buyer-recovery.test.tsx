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

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Playground } from "@/components/playground/playground";
import { stepCall } from "@/lib/buyer/deposit";
import { BUYER, HASH, SELLER } from "../helpers/buyer-fixtures";
import { buyerProvider, CHAIN_HEX, FUNDING_AMOUNT, REPLACEMENT_HASH, rpcBlock, rpcReceipt, rpcTransaction } from "../helpers/buyer-provider";

// No module mocks: the rendered page uses the actual read, send and receipt
// helpers, SDK imports and viem actions against an inert EIP-1193 provider.
let wallet: ReturnType<typeof buyerProvider>;
beforeEach(() => {
  wallet = buyerProvider();
  Object.defineProperty(window, "ethereum", { configurable: true, value: wallet.provider });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ address: wallet.state.account, network: "eip155:5042002", available: "0", availableAtomic: "0" })));
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.unstubAllGlobals();
  Object.defineProperty(window, "ethereum", { configurable: true, value: undefined });
});
async function connectedPage() {
  render(<Playground sellerAddress={SELLER} />);
  fireEvent.change(screen.getByLabelText("Browser wallet"), { target: { value: "legacy" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Connect wallet" })); });
  expect(screen.getByText(`Account: ${BUYER}`)).toBeTruthy();
}
const disabled = (name: string) => (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
const walletBalance = () => screen.getByText("Wallet USDC (also pays gas)").parentElement!.querySelector("dd")!.textContent;

describe("rendered recovery through actual helpers and viem", () => {
  it.each([
    ["eth_accounts", "error"], ["eth_chainId", "error"],
    ["eth_accounts", "timeout"], ["eth_chainId", "timeout"],
  ])("keeps funding review actionable after a pre-dispatch %s %s", async (method, failure) => {
    await connectedPage();
    fireEvent.click(screen.getByRole("button", { name: "Review funding" }));
    const submit = await screen.findByRole("button", { name: "Deposit reviewed amount" });
    let reads = 0;
    wallet.handlers.set(method, () => {
      // Submit's prepareStep checks twice; fail sendStep's own preflight.
      if (++reads === 3) {
        if (failure === "timeout") return new Promise(() => {});
        throw new Error("Synthetic pre-dispatch read failure");
      }
      return method === "eth_accounts" ? [BUYER] : CHAIN_HEX;
    });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(submit); await vi.advanceTimersByTimeAsync(failure === "timeout" ? 5001 : 1); });
    expect(screen.getByRole("alert").textContent).toContain(failure === "timeout" ? "timed out" : "Synthetic pre-dispatch");
    expect(screen.queryByText(/Awaiting wallet response/)).toBeNull();
    expect(screen.queryByText(/Submission outcome unknown/)).toBeNull();
    expect(screen.queryByRole("button", { name: /I checked wallet activity/ })).toBeNull();
    expect(disabled("Deposit reviewed amount")).toBe(false);
    expect(wallet.request.mock.calls.filter(([value]) => ["eth_sendTransaction", "wallet_sendTransaction"].includes(value.method))).toHaveLength(0);
    wallet.handlers.delete(method);
    // Recovery is an explicit user action, never an automatic submission.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Deposit reviewed amount" })); });
    expect(screen.getByText(/Deposit confirmed on Arc/)).toBeTruthy();
    expect(wallet.request.mock.calls.filter(([value]) => ["eth_sendTransaction", "wallet_sendTransaction"].includes(value.method))).toHaveLength(1);
  });
  it("requires fresh funding review when context changes before dispatch", async () => {
    await connectedPage();
    fireEvent.click(screen.getByRole("button", { name: "Review funding" }));
    const submit = await screen.findByRole("button", { name: "Deposit reviewed amount" });
    let reads = 0;
    wallet.handlers.set("eth_accounts", () => {
      if (++reads === 3) { wallet.emit("accountsChanged", [SELLER]); return [BUYER]; }
      return [wallet.state.account];
    });
    await act(async () => { fireEvent.click(submit); });
    expect(screen.queryByText(/Awaiting wallet response/)).toBeNull();
    expect(screen.queryByText(/Submission outcome unknown/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Deposit reviewed amount" })).toBeNull();
    expect(disabled("Review funding")).toBe(false);
    expect(wallet.request.mock.calls.filter(([value]) => ["eth_sendTransaction", "wallet_sendTransaction"].includes(value.method))).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review funding" })); });
    expect(screen.getByText(`Original account: ${SELLER}`)).toBeTruthy();
  });
  it("shows awaiting only for a real provider submission and keeps its prompt alive", async () => {
    await connectedPage();
    fireEvent.click(screen.getByRole("button", { name: "Review funding" }));
    const submit = await screen.findByRole("button", { name: "Deposit reviewed amount" });
    let resolve: (hash: string) => void = () => {};
    wallet.handlers.set("eth_sendTransaction", () => new Promise(done => { resolve = done; }));
    await act(async () => { fireEvent.click(submit); });
    expect(screen.getByText(/Awaiting wallet response/)).toBeTruthy();
    vi.useFakeTimers(); await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.getByText(/Awaiting wallet response/)).toBeTruthy();
    expect(wallet.request.mock.calls.filter(([value]) => ["eth_sendTransaction", "wallet_sendTransaction"].includes(value.method))).toHaveLength(1);
    await act(async () => { resolve(HASH); });
    expect(screen.getByText(/Deposit confirmed on Arc/)).toBeTruthy();
  });
  it("releases the page when an actual eth_getBalance read never settles", async () => {
    await connectedPage();
    wallet.handlers.set("eth_getBalance", () => new Promise(() => {}));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Refresh balances" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    expect(walletBalance()).toBe("Unavailable");
    expect(disabled("Get price")).toBe(false); expect(disabled("Refresh balances")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(disabled("Connect wallet")).toBe(false);
    expect((screen.getByLabelText("Browser wallet") as HTMLSelectElement).disabled).toBe(false);
  });
  it.each(["eth_accounts", "eth_chainId"])("releases the page when validation %s hangs", async method => {
    await connectedPage();
    wallet.handlers.set(method, () => new Promise(() => {}));
    vi.useFakeTimers(); fireEvent.click(screen.getByRole("button", { name: "Refresh balances" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    expect(screen.getByRole("alert").textContent).toContain("timed out");
    expect(disabled("Refresh balances")).toBe(false); expect(disabled("Get price")).toBe(false);
  });
  it("releases a stale read on Disconnect and discards it after reconnection", async () => {
    await connectedPage();
    let resolve: (value: string) => void = () => {};
    let first = true;
    wallet.handlers.set("eth_getBalance", () => {
      if (first) { first = false; return new Promise(done => { resolve = done; }); }
      return "0xde0b6b3a7640000";
    });
    vi.useFakeTimers(); fireEvent.click(screen.getByRole("button", { name: "Refresh balances" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(disabled("Connect wallet")).toBe(false);
    act(() => wallet.emit("accountsChanged", [SELLER]));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Connect wallet" })); });
    expect(screen.getByText(`Account: ${SELLER}`)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh balances" })); });
    expect(walletBalance()).toBe("1");
    await act(async () => { resolve("0xffffffffffffffffffffffff"); });
    expect(walletBalance()).toBe("1"); expect(screen.getByText(`Account: ${SELLER}`)).toBeTruthy();
  });
  it("preserves a confirmed deposit when its balance refresh times out", async () => {
    await connectedPage();
    wallet.handlers.set("eth_getBalance", () => wallet.request.mock.calls.some(([value]) => value.method === "eth_sendTransaction")
      ? new Promise(() => {}) : "0xde0b6b3a7640000");
    fireEvent.click(screen.getByRole("button", { name: "Review funding" }));
    const deposit = await screen.findByRole("button", { name: "Deposit reviewed amount" });
    vi.useFakeTimers(); fireEvent.click(deposit);
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    expect(screen.getByText(/Deposit confirmed on Arc/)).toBeTruthy();
    expect(walletBalance()).toBe("Unavailable"); expect(disabled("Get price")).toBe(false);
    expect(screen.queryByText(/Submission outcome unknown/)).toBeNull();
  });
  it.each(["approval", "deposit"] as const)("never advances a cancelled %s when the final receipt guard pauses", async step => {
    wallet.state.allowance = step === "approval" ? BigInt(0) : FUNDING_AMOUNT;
    await connectedPage();
    fireEvent.click(screen.getByRole("button", { name: "Review funding" }));
    const submit = await screen.findByRole("button", { name: step === "approval" ? "Approve exact amount" : "Deposit reviewed amount" });
    let replacementRead = false; let postReceiptReads = 0;
    wallet.handlers.set("eth_chainId", () => {
      if (replacementRead && ++postReceiptReads === 2) { wallet.emit("chainChanged", "0x1"); return "0x1"; }
      return CHAIN_HEX;
    });
    wallet.handlers.set("eth_getTransactionReceipt", params => {
      if ((params as string[])[0] === HASH) return null;
      replacementRead = true; return { ...rpcReceipt(REPLACEMENT_HASH), to: BUYER };
    });
    wallet.handlers.set("eth_getTransactionByHash", () => rpcTransaction(HASH, stepCall(step, FUNDING_AMOUNT)));
    wallet.handlers.set("eth_getBlockByNumber", () => rpcBlock([{ ...rpcTransaction(REPLACEMENT_HASH), to: BUYER, input: "0x" }]));
    vi.useFakeTimers(); fireEvent.click(submit);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByText(/Transaction cancelled. The reviewed operation was not confirmed/)).toBeTruthy();
    act(() => wallet.emit("chainChanged", CHAIN_HEX));
    expect(screen.queryByRole("button", { name: "Review deposit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check receipt" })).toBeNull();
    expect(screen.queryByText(/Deposit confirmed on Arc/)).toBeNull();
  });
});
