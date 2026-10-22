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
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Playground } from "@/components/playground/playground";
import { chain } from "@/lib/buyer/network";
import { encodeHeader } from "@/lib/buyer/http";
import { resources } from "@/lib/buyer/resources";
import { useInjectedWallet } from "@/hooks/use-injected-wallet";
import { ack, BUYER, challenge, fakeWallet, HASH, REFERENCE, SELLER } from "../helpers/buyer-fixtures";

const deposit = vi.hoisted(() => ({ allowance: vi.fn(), prepareStep: vi.fn(), sendStep: vi.fn(), waitForStep: vi.fn(), getBalance: vi.fn() }));
vi.mock("@/lib/buyer/deposit", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/buyer/deposit")>(),
  ...deposit,
  publicWallet: () => ({ getBalance: deposit.getBalance }),
}));

let wallet: ReturnType<typeof fakeWallet>;
let fetchMock: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<Response>>>;
beforeEach(() => {
  wallet = fakeWallet();
  Object.defineProperty(window, "ethereum", { configurable: true, value: wallet.provider });
  deposit.allowance.mockReset().mockResolvedValue(BigInt(0));
  deposit.prepareStep.mockReset().mockImplementation(async (_context, _step, _amount, current) => {
    if (!current()) throw new Error("Wallet context changed.");
    return { fee: BigInt(1000) };
  });
  deposit.sendStep.mockReset().mockImplementation(async (_context, _request, _current, onDispatch) => { onDispatch(); return HASH; });
  deposit.waitForStep.mockReset().mockResolvedValue({ kind: "confirmed", hash: HASH });
  deposit.getBalance.mockReset().mockResolvedValue(BigInt(1000000000000000000));
  fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/buyer/balance")) return Response.json({ address: BUYER, network: "eip155:5042002", available: "0", availableAtomic: "0" });
    if (new Headers(init?.headers).has("PAYMENT-SIGNATURE")) return new Response("paid resource ☀", { headers: { "PAYMENT-RESPONSE": encodeHeader(ack()) } });
    const data = challenge();
    const resource = resources.find(value => value.path === path)!;
    data.resource.url = path; data.accepts[0].amount = String(Math.round(Number(resource.price) * 1e6));
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodeHeader(data) } });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Object.defineProperty(window, "ethereum", { configurable: true, value: undefined }); });

async function connect() {
  fireEvent.change(screen.getByLabelText("Browser wallet"), { target: { value: "legacy" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
  await screen.findByText(`Account: ${BUYER}`);
}
async function reviewPrice() {
  fireEvent.click(screen.getByRole("button", { name: "Get price" }));
  return screen.findByRole("button", { name: /Pay .* USDC and request resource/ });
}
async function fundingReview() {
  fireEvent.click(screen.getByRole("button", { name: "Review funding" }));
  return screen.findByRole("button", { name: "Approve exact amount" });
}

describe("rendered buyer wallet lifecycle", () => {
  it("does not request accounts or fund anything on render, including StrictMode", () => {
    const view = render(<StrictMode><Playground sellerAddress={SELLER} /></StrictMode>);
    expect(wallet.request).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
    expect(deposit.sendStep).not.toHaveBeenCalled(); view.unmount();
    expect([...wallet.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
  });
  it("renders without an extension and keeps a read-only catalog", () => {
    Object.defineProperty(window, "ethereum", { configurable: true, value: undefined });
    render(<Playground sellerAddress={null} />);
    expect(screen.getByText(/No injected wallet found/)).toBeTruthy();
    expect(screen.getByLabelText("Resource").children.length).toBe(4);
    expect((screen.getByRole("button", { name: "Get price" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("handles an accountsChanged event emitted during connection", async () => {
    const original = wallet.request.getMockImplementation()!;
    wallet.request.mockImplementation(async request => {
      if (request.method === "eth_requestAccounts") wallet.emit("accountsChanged", [BUYER]);
      return original(request);
    });
    render(<Playground sellerAddress={SELLER} />); await connect();
    expect((screen.getByRole("button", { name: "Get price" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("does not reconnect from external events after local disconnect", async () => {
    render(<Playground sellerAddress={SELLER} />); await connect();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    act(() => wallet.emit("accountsChanged", [BUYER]));
    expect(screen.queryByText(`Account: ${BUYER}`)).toBeNull();
  });
  it("keeps old callbacks bound to their original generation", async () => {
    const { result } = renderHook(() => useInjectedWallet());
    act(() => result.current.select("legacy"));
    await act(async () => { await result.current.connect(); });
    const oldContext = result.current.context;
    expect(result.current.current(oldContext()!)).toBe(true);
    act(() => wallet.emit("accountsChanged", [SELLER]));
    expect(result.current.current(oldContext()!)).toBe(false);
    expect(result.current.context()?.address).toBe(SELLER);
  });
  it("does not overwrite a wallet change during the connection reads", async () => {
    const original = wallet.request.getMockImplementation()!;
    wallet.request.mockImplementation(async request => {
      if (request.method === "eth_chainId") wallet.emit("accountsChanged", [SELLER]);
      return original(request);
    });
    render(<Playground sellerAddress={SELLER} />);
    fireEvent.change(screen.getByLabelText("Browser wallet"), { target: { value: "legacy" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    await screen.findByText(/Wallet changed while connecting/);
    expect(screen.queryByText(`Account: ${BUYER}`)).toBeNull();
  });
  it("discovers/deduplicates EIP6963 wallets without requesting accounts", async () => {
    render(<Playground sellerAddress={SELLER} />);
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "example-wallet", name: "Example" }, provider: wallet.provider } }));
    act(() => { announce(); announce(); });
    expect(screen.getAllByRole("option", { name: /Example|Browser wallet/ }).length).toBe(1);
    expect(wallet.request).not.toHaveBeenCalled();
  });
  it("retains the selected fallback when a different wallet announces later", async () => {
    render(<Playground sellerAddress={SELLER} />); await connect();
    const other = fakeWallet();
    act(() => { window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "other", name: "Other wallet" }, provider: other.provider } })); });
    expect((screen.getByLabelText("Browser wallet") as HTMLSelectElement).value).toBe("legacy");
    await reviewPrice();
    expect(other.request).not.toHaveBeenCalled();
    expect(screen.getByText(`Account: ${BUYER}`)).toBeTruthy();
  });
  it("shows actual zero Gateway balance separately from unavailable", async () => {
    render(<Playground sellerAddress={SELLER} />); await connect();
    fireEvent.click(screen.getByRole("button", { name: "Refresh balances" }));
    await screen.findByText("0");
    fetchMock.mockResolvedValue(new Response("no", { status: 502 }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh balances" }));
    await screen.findByText("Unavailable");
    expect(screen.queryByText("0")).toBeNull();
  });
});

describe("rendered explicit purchase", () => {
  it("requires an explicit payment click and prevents duplicate signing/dispatch", async () => {
    render(<StrictMode><Playground sellerAddress={SELLER} /></StrictMode>); await connect();
    const pay = await reviewPrice();
    expect(wallet.request.mock.calls.some(([request]) => request.method === "eth_signTypedData_v4")).toBe(false);
    act(() => { fireEvent.click(pay); fireEvent.click(pay); });
    await screen.findByText(/Gateway acceptance acknowledged/);
    expect(wallet.request.mock.calls.filter(([request]) => request.method === "eth_signTypedData_v4")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([, init]) => new Headers(init?.headers).has("PAYMENT-SIGNATURE"))).toHaveLength(1);
    expect(screen.getByText(new RegExp(REFERENCE))).toBeTruthy();
  });
  it("preserves the exact compute POST body between challenge and purchase", async () => {
    render(<Playground sellerAddress={SELLER} />); await connect();
    fireEvent.change(screen.getByLabelText("Resource"), { target: { value: "compute" } });
    fireEvent.change(screen.getByLabelText(/Compute text/), { target: { value: "A precise input ☀" } });
    fireEvent.click(await reviewPrice()); await screen.findByText(/Gateway acceptance acknowledged/);
    const calls = fetchMock.mock.calls.filter(([path]) => path === resources[2].path);
    expect(calls).toHaveLength(2);
    expect(calls.map(([, init]) => [init?.method, init?.body])).toEqual([["POST", '{"text":"A precise input ☀"}'], ["POST", '{"text":"A precise input ☀"}']]);
  });
  it("invalidates a quote when the account changes", async () => {
    render(<Playground sellerAddress={SELLER} />); await connect(); await reviewPrice();
    act(() => wallet.emit("accountsChanged", [SELLER]));
    expect((screen.getByRole("button", { name: /Pay .* USDC and request resource/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Wallet changed. Get price again/)).toBeTruthy();
  });
  it("discards a late signature after a network change", async () => {
    let resolve: (value: string) => void = () => {};
    const original = wallet.request.getMockImplementation()!;
    wallet.request.mockImplementation(request => request.method === "eth_signTypedData_v4" ? new Promise<string>(done => { resolve = done; }) : original(request));
    render(<Playground sellerAddress={SELLER} />); await connect(); fireEvent.click(await reviewPrice());
    await waitFor(() => expect(wallet.request.mock.calls.some(([request]) => request.method === "eth_signTypedData_v4")).toBe(true));
    await act(async () => { wallet.emit("chainChanged", "0x1"); resolve(`0x${"11".repeat(65)}`); });
    await screen.findByText(/Payment request not submitted/);
    expect(fetchMock.mock.calls.filter(([, init]) => new Headers(init?.headers).has("PAYMENT-SIGNATURE"))).toHaveLength(0);
  });
  it("retains an ambiguous outcome while preparing an explicit new purchase", async () => {
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((path, init) => new Headers(init?.headers).has("PAYMENT-SIGNATURE") ? Promise.reject(new Error("lost response")) : original(path, init));
    render(<Playground sellerAddress={SELLER} />); await connect(); fireEvent.click(await reviewPrice());
    await screen.findByText(/Payment confirmation unavailable/);
    await reviewPrice();
    expect(screen.getByText(/Payment confirmation unavailable/)).toBeTruthy();
  });
});

describe("rendered deposit failure semantics", () => {
  it.each(["cancelled", "replaced", "reverted"])("never advances approval on a %s receipt", async kind => {
    deposit.waitForStep.mockResolvedValue({ kind, hash: HASH });
    render(<Playground sellerAddress={SELLER} />); await connect(); fireEvent.click(await fundingReview());
    await waitFor(() => expect(deposit.waitForStep).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Start new funding review" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Review deposit" })).toBeNull();
    expect(deposit.sendStep).toHaveBeenCalledTimes(1);
  });
  it("requires separate explicit deposit review and submission after approval", async () => {
    render(<Playground sellerAddress={SELLER} />); await connect(); fireEvent.click(await fundingReview());
    fireEvent.click(await screen.findByRole("button", { name: "Review deposit" }));
    const button = await screen.findByRole("button", { name: "Deposit reviewed amount" });
    expect(deposit.sendStep).toHaveBeenCalledTimes(1);
    fireEvent.click(button); await screen.findByText(/Deposit confirmed on Arc/);
    expect(deposit.sendStep).toHaveBeenCalledTimes(2);
  });
  it("retains original details if provider accepted then lost the hash response", async () => {
    deposit.sendStep.mockImplementation(async (_context, _request, _current, onDispatch) => { onDispatch(); throw { code: 4900, message: "response lost after broadcast" }; });
    render(<Playground sellerAddress={SELLER} />); await connect(); fireEvent.click(await fundingReview());
    await screen.findByText(/Submission outcome unknown; hash unavailable/);
    expect(screen.getByText(`Original account: ${BUYER}`)).toBeTruthy();
    expect(deposit.waitForStep).not.toHaveBeenCalled(); expect(deposit.sendStep).toHaveBeenCalledTimes(1);
  });
  it("keeps deposit confirmation even when a wallet change breaks balance refresh", async () => {
    deposit.allowance.mockResolvedValue(BigInt(100000));
    const original = wallet.request.getMockImplementation()!;
    wallet.request.mockImplementation(async request => {
      if (request.method === "eth_accounts" && deposit.waitForStep.mock.calls.length) wallet.emit("chainChanged", "0x1");
      return original(request);
    });
    render(<Playground sellerAddress={SELLER} />); await connect();
    fireEvent.click(screen.getByRole("button", { name: "Review funding" }));
    fireEvent.click(await screen.findByRole("button", { name: "Deposit reviewed amount" }));
    await screen.findByText(/Deposit confirmed on Arc/);
    await screen.findByText(/Deposit confirmed; balance refresh unavailable/);
    expect(screen.queryByText(/Submission outcome unknown/)).toBeNull();
    expect(screen.getByRole("link", { name: `Transaction: ${HASH}` })).toBeTruthy();
  });
  it("allows manual receipt rechecking after returning to Arc", async () => {
    deposit.waitForStep.mockImplementationOnce(async () => { wallet.emit("chainChanged", "0x1"); return { kind: "paused", hash: HASH }; });
    render(<Playground sellerAddress={SELLER} />); await connect(); fireEvent.click(await fundingReview());
    const check = await screen.findByRole("button", { name: "Check receipt" });
    expect((check as HTMLButtonElement).disabled).toBe(true);
    act(() => wallet.emit("chainChanged", `0x${chain.id.toString(16)}`));
    fireEvent.click(check); await screen.findByRole("button", { name: "Review deposit" });
    expect(deposit.waitForStep).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Review deposit" }));
    await screen.findByRole("button", { name: "Deposit reviewed amount" });
  });
});
