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

import { useState } from "react";
import { formatUnits } from "viem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { allowance, prepareStep, sendStep, waitForStep, type DepositAttempt, type DepositStep, type ReceiptOutcome } from "@/lib/buyer/deposit";
import { chain, sameAddress, usdcAtomic, usdcDisplay } from "@/lib/buyer/network";
import { message } from "@/lib/buyer/http";
import { userRejected, type WalletContext } from "@/lib/buyer/wallet";

export interface OperationControl {
  busy: boolean;
  run: (operation: () => Promise<void>) => Promise<void>;
  context: () => WalletContext | null;
  current: (context: WalletContext) => boolean;
}

interface DepositState {
  attempt: DepositAttempt;
  kind: "review" | "ready" | "awaiting" | "unknown" | "rejected" | ReceiptOutcome["kind"];
  fee?: bigint;
  note?: string;
}

export function DepositPanel({ control, onRefresh, enabled }: { control: OperationControl; onRefresh: () => Promise<void>; enabled: boolean }) {
  const [amount, setAmount] = useState("0.1");
  const [state, setState] = useState<DepositState | null>(null);
  const [error, setError] = useState("");

  async function review() {
    await control.run(async () => {
      setError("");
      try {
        const context = control.context();
        if (!context) throw new Error("Connect a wallet first.");
        const atomic = usdcAtomic(amount, true);
        const step: DepositStep = await allowance(context, () => control.current(context)) >= atomic ? "deposit" : "approval";
        const attempt = { context, amount: atomic, step };
        const request = await prepareStep(context, step, atomic, () => control.current(context));
        if (!control.current(context)) throw new Error("Wallet changed. Review again.");
        setState({ attempt, kind: "review", fee: request?.fee });
      } catch (error) { setError(message(error)); }
    });
  }

  async function receipt(attempt: DepositAttempt, readContext: WalletContext) {
    const outcome = await waitForStep(attempt, () => control.current(readContext) && readContext.provider === attempt.context.provider);
    const updated = { ...attempt, hash: outcome.hash, replacement: outcome.replacement };
    setState({ attempt: updated, kind: outcome.kind });
    if (outcome.kind === "confirmed" && attempt.step === "approval") {
      // This read cannot advance to a transaction. Deposit remains a separate
      // explicit action with fresh allowance, context and fee validation.
      setState({ attempt: updated, kind: "ready", note: "Approval confirmed. Review the deposit as a separate transaction." });
    }
    if (outcome.kind === "confirmed" && attempt.step === "deposit") {
      try { await onRefresh(); }
      catch { setError("Deposit confirmed; balance refresh unavailable. Refresh manually on Arc Testnet."); }
    }
  }

  async function submit() {
    if (!state || state.kind !== "review") return;
    const attempt = state.attempt;
    await control.run(async () => {
      setError("");
      let invoked = false;
      let broadcast: DepositAttempt | undefined;
      try {
        // Re-estimate on the explicit click, including funds remaining after any
        // approval. The wallet also presents the final transaction fee.
        const request = await prepareStep(attempt.context, attempt.step, attempt.amount, () => control.current(attempt.context));
        if (!request) {
          setState({ attempt, kind: "ready", note: "Allowance is already sufficient. Review the deposit." });
          return;
        }
        const hash = await sendStep(attempt.context, request, () => control.current(attempt.context), () => {
          invoked = true;
          setState({ attempt, kind: "awaiting" });
        });
        broadcast = { ...attempt, hash };
        setState({ attempt: broadcast, kind: "pending" });
        await receipt(broadcast, attempt.context);
      } catch (error) {
        if (broadcast) setState({ attempt: broadcast, kind: "pending" });
        else if (invoked) setState({ attempt, kind: userRejected(error) ? "rejected" : "unknown" });
        else {
          if (!control.current(attempt.context)) setState(null);
          setError(`Transaction not submitted. ${message(error)}`);
        }
      }
    });
  }

  async function reviewDeposit() {
    if (!state) return;
    const { attempt } = state;
    await control.run(async () => {
      setError("");
      try {
        const context = control.context();
        if (!context || context.provider !== attempt.context.provider || !sameAddress(context.address, attempt.context.address)) {
          throw new Error("Select the original wallet account before reviewing the deposit.");
        }
        const request = await prepareStep(context, "deposit", attempt.amount, () => control.current(context));
        setState({ attempt: { ...attempt, context, step: "deposit", hash: undefined }, kind: "review", fee: request?.fee });
      } catch (error) { setError(message(error)); }
    });
  }

  const unresolved = state && ["unknown", "pending", "paused", "awaiting"].includes(state.kind);
  return <section className="rounded-lg border p-4 space-y-3" aria-labelledby="deposit-title">
    <h2 id="deposit-title" className="font-semibold">Deposit to Gateway</h2>
    <p className="text-sm text-muted-foreground">Deposited USDC pays for resources. Wallet USDC also pays transaction gas. Approval and deposit require separate confirmations.</p>
    <div className="flex flex-wrap items-end gap-2">
      <div><Label htmlFor="deposit-amount">Deposit USDC</Label><Input id="deposit-amount" value={amount} inputMode="decimal" disabled={control.busy || !!state}
        onChange={event => setAmount(event.target.value)} /></div>
      <Button variant="outline" disabled={!enabled || control.busy || !!state} onClick={review}>Review funding</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {state && <div className="space-y-2 text-sm" role="status" aria-live="polite">
      <p>{state.attempt.step === "approval" ? "Approval" : "Deposit"}: {usdcDisplay(state.attempt.amount)} USDC · Arc Testnet</p>
      <p className="break-all">Original account: {state.attempt.context.address}</p>
      {state.attempt.hash && <a className="underline break-all" href={`${chain.blockExplorers.default.url}/tx/${state.attempt.hash}`} target="_blank" rel="noreferrer">Transaction: {state.attempt.hash}</a>}
      {state.kind === "review" && <>
        <p>Exact amount only. Estimated maximum gas: {state.fee === undefined ? "unavailable" : `${formatUnits(state.fee, 18)} USDC`}. Wallet confirms final fees.</p>
        <Button disabled={control.busy || !enabled} onClick={submit}>{state.attempt.step === "approval" ? "Approve exact amount" : "Deposit reviewed amount"}</Button>
      </>}
      {state.kind === "awaiting" && <p>Awaiting wallet response. Reject in the wallet to cancel; closing this page cannot undo a broadcast.</p>}
      {state.kind === "ready" && <><p>{state.note}</p><Button disabled={control.busy || !enabled} onClick={reviewDeposit}>Review deposit</Button></>}
      {state.kind === "confirmed" && <p>Deposit confirmed on Arc. Gateway credit can lag; refresh balances manually.</p>}
      {state.kind === "cancelled" && <p>Transaction cancelled. The reviewed operation was not confirmed.</p>}
      {state.kind === "replaced" && <p>Transaction replaced by a different operation. No deposit/approval success is assumed.</p>}
      {state.kind === "reverted" && <p>Transaction reverted. This step did not complete.</p>}
      {state.kind === "rejected" && <p>Wallet request rejected.</p>}
      {state.kind === "unknown" && <p>Submission outcome unknown; hash unavailable. Inspect the original wallet&apos;s activity before intentionally starting another deposit.</p>}
      {state.kind === "pending" && <p>Receipt not confirmed yet. Keep this hash; do not resend as a retry.</p>}
      {state.kind === "paused" && <p>Receipt reads paused after a wallet change. Select Arc Testnet in the original wallet, then check the receipt.</p>}
      {state.attempt.hash && ["pending", "paused"].includes(state.kind) && <Button variant="outline" disabled={control.busy || !enabled}
        onClick={() => control.run(async () => {
          const readContext = control.context();
          if (readContext?.provider !== state.attempt.context.provider) { setError("Select the original browser wallet."); return; }
          await receipt(state.attempt, readContext);
        })}>Check receipt</Button>}
      {!control.busy && <Button variant="ghost" onClick={() => { setState(null); setError(""); }}>
        {unresolved ? "I checked wallet activity; start a new funding review" : "Start new funding review"}
      </Button>}
    </div>}
    <p className="text-xs text-muted-foreground">Attempt details are kept only while this page stays open. After a reload, inspect wallet activity before depositing again.</p>
  </section>;
}
