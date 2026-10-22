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
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { resources, resourceBody } from "@/lib/buyer/resources";
import { getPrice, signQuote, submitPurchase, type PurchaseResult, type Quote } from "@/lib/buyer/protocol";
import { message } from "@/lib/buyer/http";
import { usdcDisplay } from "@/lib/buyer/network";
import { assertWallet, type WalletContext } from "@/lib/buyer/wallet";
import type { OperationControl } from "./deposit-panel";

export function PurchasePanel({ sellerAddress, control, enabled }: { sellerAddress: `0x${string}` | null; control: OperationControl; enabled: boolean }) {
  const [resourceId, setResourceId] = useState<string>(resources[0].id);
  const [text, setText] = useState("Hello, Arc nanopayments.");
  const [review, setReview] = useState<{ quote: Quote; context: WalletContext } | null>(null);
  const [result, setResult] = useState<{ value: PurchaseResult; account: string } | null>(null);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const controller = useRef<AbortController | null>(null);
  const active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  const resource = resources.find(value => value.id === resourceId)!;
  const validReview = review && control.current(review.context);

  async function price() {
    if (!sellerAddress) return;
    await control.run(async () => {
      setError(""); setCopied(""); setReview(null);
      const context = control.context();
      if (!context) return;
      const request = new AbortController(); controller.current = request;
      const timer = setTimeout(() => request.abort(), 20000);
      try {
        await assertWallet(context, () => control.current(context));
        setStage("Requesting price…");
        const value = await getPrice(resource, resourceBody(resource, text), sellerAddress!, request.signal);
        if (!active.current || !control.current(context)) return;
        if ("requirements" in value) setReview({ quote: value, context });
        else setResult({ value, account: context.address });
      } catch (error) { if (active.current) setError(message(error)); }
      finally { clearTimeout(timer); if (active.current) setStage(""); }
    });
  }

  async function pay() {
    if (!review || !validReview) return;
    const frozen = review;
    await control.run(async () => {
      setError(""); setCopied("");
      // Consume the quote before awaiting any wallet operation, including a
      // rejected signature. A new purchase always needs a new explicit review.
      setReview(null);
      try {
        setStage("Awaiting wallet signature…");
        const signature = await signQuote(frozen.quote, frozen.context, () => active.current && control.current(frozen.context));
        if (!active.current || !control.current(frozen.context)) return;
        setStage("Sending paid request…");
        const request = new AbortController(); controller.current = request;
        const timer = setTimeout(() => request.abort(), 20000);
        try {
          const value = await submitPurchase(frozen.quote, signature, frozen.context.address, request.signal);
          if (active.current) setResult({ value, account: frozen.context.address });
        } finally { clearTimeout(timer); }
      } catch (error) { if (active.current) setError(`Payment request not submitted. ${message(error)}`); }
      finally { if (active.current) setStage(""); }
    });
  }

  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setCopied(`${label} copied.`); }
    catch { setCopied("Clipboard unavailable. Select and copy the displayed text."); }
  }

  return <section className="rounded-lg border p-4 space-y-4" aria-labelledby="resource-title">
    <h2 id="resource-title" className="font-semibold">Try a paid resource</h2>
    <div className="space-y-2">
      <Label htmlFor="buyer-resource">Resource</Label>
      <select id="buyer-resource" className="w-full rounded-md border bg-background p-2" value={resourceId} disabled={control.busy}
        onChange={event => { setResourceId(event.target.value); setReview(null); }}>
        {resources.map(value => <option key={value.id} value={value.id}>{value.name} · {value.price} USDC</option>)}
      </select>
      <p className="text-xs font-mono break-all">{resource.method} {resource.path}</p>
    </div>
    {resource.method === "POST" && <div className="space-y-2"><Label htmlFor="compute-text">Compute text (up to 2,000 characters)</Label>
      <textarea id="compute-text" maxLength={2000} rows={4} className="w-full rounded-md border bg-background p-2" value={text} disabled={control.busy}
        onChange={event => { setText(event.target.value); setReview(null); }} /></div>}
    <Button disabled={!enabled || !sellerAddress || control.busy} onClick={price} variant="outline">Get price</Button>
    {!sellerAddress && <p role="status">Purchases disabled: SELLER_ADDRESS is missing or invalid. Configure the seller and reload this page.</p>}
    {review && <div className="rounded-md bg-muted p-3 space-y-2 text-sm">
      <h3 className="font-semibold">Review payment</h3>
      <p>{review.quote.resource.name}: {usdcDisplay(BigInt(review.quote.requirements.amount))} USDC · Arc Testnet</p>
      <p className="break-all">Recipient: {review.quote.requirements.payTo}</p>
      <p className="break-all">Buyer: {review.context.address}</p>
      <p>This signature authorizes a Gateway payment. It is not a sign-in.</p>
      <details><summary>Authorization details</summary><p>The SDK authorizes this exact amount for at least seven days plus 100 seconds, with a ten-minute clock allowance before signing. The reviewed price must be refreshed after 60 seconds. Disconnecting cannot revoke the signature.</p></details>
      {!validReview && <p>Wallet changed. Get price again before signing.</p>}
      <Button disabled={control.busy || !enabled || !validReview} onClick={pay}>Pay {usdcDisplay(BigInt(review.quote.requirements.amount))} USDC and request resource</Button>
    </div>}
    <p role="status" aria-live="polite">{stage}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {result && <div className="space-y-2 text-sm border-t pt-3">
      <h3 className="font-semibold">Latest request result</h3>
      <p className="break-all">Original buyer: {result.account}</p>
      <p>HTTP: {result.value.status ?? "response unavailable"}</p>
      <p>{result.value.payment === "acknowledged" ? "Gateway acceptance acknowledged. Chain settlement not checked." :
        result.value.payment === "unpaywalled" ? "Resource is not paywalled. No payment was submitted." : "Payment confirmation unavailable. Outcome may be unknown; inspect before making another purchase."}</p>
      {result.value.note && <p>{result.value.note}</p>}
      {result.value.reference && <><p className="break-all">Gateway reference: {result.value.reference} (not a chain transaction hash)</p><Button size="sm" variant="outline" onClick={() => copy(result.value.reference!, "Reference")}>Copy reference</Button></>}
      {result.value.text && <><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3">{result.value.text}</pre>
        <Button size="sm" variant="outline" onClick={() => copy(result.value.text, "Resource")}>Copy resource</Button></>}
      <p role="status">{copied}</p>
    </div>}
  </section>;
}
