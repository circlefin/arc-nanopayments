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

"use client";

import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useInjectedWallet } from "@/hooks/use-injected-wallet";
import { chain, NETWORK, sameAddress, usdcAtomic, usdcDisplay, type BuyerConfig } from "@/lib/buyer/network";
import { boundedText, message, object } from "@/lib/buyer/http";
import { assertWallet, readWithDeadline, type WalletContext } from "@/lib/buyer/wallet";
import { publicWallet } from "@/lib/buyer/deposit";
import { DepositPanel, type OperationControl } from "./deposit-panel";
import { PurchasePanel } from "./purchase-panel";

export function Playground({ sellerAddress }: BuyerConfig) {
  const wallet = useInjectedWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [balances, setBalances] = useState<{ context: WalletContext; wallet: string; gateway: string; checkedAt: string } | null>(null);
  const lock = useRef(false);
  const active = useRef(false);
  const balanceRequest = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; balanceRequest.current?.abort(); }; }, []);

  async function run(operation: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setError("");
    try { await operation(); }
    catch (error) { if (active.current) setError(message(error)); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  const control: OperationControl = { busy, run, context: wallet.context, current: wallet.current };
  const enabled = !!wallet.address && wallet.chainId === chain.id && !wallet.pending;

  async function refresh() {
    const context = wallet.context();
    if (!context) return;
    setBalances(null);
    const request = new AbortController(); balanceRequest.current = request;
    let reading = true;
    const current = () => reading && wallet.current(context);
    try {
      const [native, gateway] = await readWithDeadline(async () => {
        await assertWallet(context, current);
        const values = await Promise.all([
          publicWallet(context, current).getBalance({ address: context.address }).then(value => formatUnits(value, 18)).catch(() => "Unavailable"),
          (async () => {
            try {
              const response = await fetch(`/api/buyer/balance?address=${context.address}`, { signal: request.signal, cache: "no-store", credentials: "omit", redirect: "error" });
              if (!response.ok) return "Unavailable";
              const value: unknown = JSON.parse(await boundedText(response));
              if (!object(value) || !sameAddress(value.address, context.address) || value.network !== NETWORK ||
                typeof value.availableAtomic !== "string" || !/^\d+$/.test(value.availableAtomic) || usdcAtomic(value.available).toString() !== value.availableAtomic) return "Unavailable";
              return usdcDisplay(BigInt(value.availableAtomic));
            } catch { return "Unavailable"; }
          })(),
        ]);
        await assertWallet(context, current);
        return values;
      }, current, 7000);
      if (active.current) setBalances({ context, wallet: native, gateway, checkedAt: new Date().toLocaleTimeString() });
    } finally { reading = false; request.abort(); }
  }
  const visibleBalance = balances && wallet.current(balances.context) ? balances : null;

  return <main className="mx-auto max-w-4xl p-4 sm:p-8 space-y-6">
    <header className="space-y-2"><div className="flex flex-wrap justify-between gap-2"><h1 className="text-2xl font-semibold">Buyer playground</h1><Link className="underline" href="/">Seller sign-in</Link></div>
      <p>Arc Testnet · Choose a resource, review its price and make one deliberate purchase with a browser wallet.</p>
      <p className="text-sm text-muted-foreground">Test funds only. MetaMask desktop is the initial wallet target. The seller app and database still need to be configured.</p></header>
    <section aria-labelledby="wallet-title" className="rounded-lg border p-4 space-y-3">
      <h2 id="wallet-title" className="font-semibold">Wallet</h2>
      {!wallet.choices.length ? <p>No injected wallet found. Install a browser wallet such as MetaMask to connect. No wallet request occurs until you choose Connect.</p> : <>
        <Label htmlFor="buyer-wallet">Browser wallet</Label><select id="buyer-wallet" value={wallet.selected} disabled={busy || wallet.pending} className="w-full rounded-md border bg-background p-2" onChange={event => wallet.select(event.target.value)}>
          <option value="">Choose a wallet</option>{wallet.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
        </select>
        <div className="flex flex-wrap gap-2">
          {!wallet.address ? <Button disabled={!wallet.provider || busy || wallet.pending} onClick={wallet.connect}>Connect wallet</Button> : <>
            <Button variant="outline" disabled={wallet.pending} onClick={wallet.disconnect}>Disconnect</Button>
            {wallet.chainId !== chain.id && <Button disabled={busy || wallet.pending} onClick={wallet.switchNetwork}>{wallet.needsAdd ? "Add Arc Testnet" : "Switch to Arc Testnet"}</Button>}
          </>}
          <Button variant="outline" disabled={!enabled || busy} onClick={() => run(refresh)}>Refresh balances</Button>
        </div>
      </>}
      {wallet.address && <><p className="break-all text-sm">Account: {wallet.address}</p><p className="text-sm">Network: {wallet.chainId === chain.id ? "Arc Testnet" : wallet.chainId ?? "unknown"}</p></>}
      <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-sm text-muted-foreground">Wallet USDC (also pays gas)</dt><dd>{visibleBalance?.wallet ?? "Not checked"}</dd></div><div><dt className="text-sm text-muted-foreground">Gateway available USDC</dt><dd>{visibleBalance?.gateway ?? "Not checked"}</dd></div></dl>
      {visibleBalance && <p className="text-xs">Checked at {visibleBalance.checkedAt}. Refresh manually after funding or a purchase.</p>}
      <a className="text-sm underline" href="https://faucet.circle.com" target="_blank" rel="noreferrer">Get testnet USDC from Circle&apos;s faucet</a>
      {wallet.error && <p role="alert" className="text-sm text-destructive">{wallet.error}</p>}
    </section>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <DepositPanel control={control} enabled={enabled} onRefresh={refresh} />
    <PurchasePanel control={control} enabled={enabled} sellerAddress={sellerAddress} />
  </main>;
}
