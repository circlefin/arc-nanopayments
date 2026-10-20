/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { PaymentEvent } from "@/hooks/use-transactions";
import { isUuid, settlementStatusLabel, type SettlementSnapshot } from "@/lib/payment-settlement";

export function PaymentDetailsDialog({ payment }: { payment: PaymentEvent }) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<SettlementSnapshot | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => () => { pending.current?.abort(); }, []);

  function changeOpen(next: boolean) {
    pending.current?.abort();
    pending.current = null;
    setSnapshot(null);
    setError(null);
    setChecking(false);
    setCopyMessage(null);
    setOpen(next);
  }

  async function checkSettlement() {
    if (pending.current || !isUuid(payment.gateway_tx)) return;
    const controller = new AbortController();
    pending.current = controller;
    setChecking(true);
    setError(null);
    let message = "Could not check settlement. Please try again.";
    try {
      const response = await fetch(`/api/gateway/payments/${encodeURIComponent(payment.id)}/settlement`, {
        cache: "no-store", signal: controller.signal,
      });
      // The proxy can answer before the handler, using PR #42's unchanged body.
      if (response.status === 401) {
        message = "Your session has expired. Please sign in again.";
        throw new Error(message);
      }
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) message = "Settlement lookup is unavailable for this record.";
        if (response.status === 404) {
          message = data?.code === "transfer_not_found"
            ? "Gateway did not return this transfer. This does not establish payment failure."
            : "This payment record is no longer available.";
        }
        throw new Error(message);
      }
      if (!data || data.paymentEventId !== payment.id || data.transferId !== payment.gateway_tx ||
          typeof data.status !== "string" || typeof data.checkedAt !== "string") {
        throw new Error("Could not check settlement. Please try again.");
      }
      if (pending.current === controller && !controller.signal.aborted) setSnapshot(data);
    } catch {
      if (pending.current === controller && !controller.signal.aborted) {
        setError(message);
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setChecking(false);
      }
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage("Copied.");
    } catch {
      setCopyMessage("Could not copy. Select the reference to copy it manually.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`View payment details for ${payment.endpoint}`}>Details</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Payment details</DialogTitle>
          <DialogDescription>A recorded payment and its last checked Gateway settlement state.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt>Amount</dt><dd className="font-mono">{payment.amount_usdc} USDC</dd>
          <dt>Endpoint</dt><dd className="break-all">{payment.endpoint}</dd>
          <dt>Payer</dt><dd className="font-mono break-all">{payment.payer}</dd>
          <dt>Network</dt><dd>{payment.network}</dd>
          <dt>Recorded at</dt><dd>{new Date(payment.created_at).toLocaleString()}</dd>
          <dt>{isUuid(payment.gateway_tx) ? "Gateway transfer ID" : "Payment reference"}</dt>
          <dd className="font-mono break-all">{payment.gateway_tx || "Not recorded"}</dd>
        </dl>
        {payment.gateway_tx && (
          <Button variant="outline" size="sm" onClick={() => copy(payment.gateway_tx!)}>Copy payment reference</Button>
        )}
        <div className="border-t pt-3 space-y-2" aria-live="polite">
          <p className="font-medium">Settlement</p>
          {snapshot ? (
            <>
              <p>{settlementStatusLabel(snapshot.status)}</p>
              <p className="text-xs text-muted-foreground">
                {error || checking ? "Last successful check" : "Last checked"}: {new Date(snapshot.checkedAt).toLocaleString()}
              </p>
              {snapshot.txHash && (
                <div className="space-y-1">
                  <p className="text-xs">Batch transaction hash</p>
                  <p className="font-mono text-xs break-all">{snapshot.txHash}</p>
                  <Button variant="outline" size="sm" onClick={() => copy(snapshot.txHash!)}>Copy batch hash</Button>
                </div>
              )}
            </>
          ) : <p>{checking ? "Checking…" : error ? "No successful check yet." : "Not checked"}</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {!isUuid(payment.gateway_tx) && <p className="text-sm text-muted-foreground">This record has no Gateway transfer ID available for lookup.</p>}
          <p className="text-xs text-muted-foreground">A status check does not establish resource delivery or your current available balance.</p>
        </div>
        <Button onClick={checkSettlement} disabled={checking || !isUuid(payment.gateway_tx)}>
          {checking ? "Checking…" : snapshot || error ? "Check again" : "Check settlement"}
        </Button>
        {copyMessage && <p role="status" className="text-xs">{copyMessage}</p>}
      </DialogContent>
    </Dialog>
  );
}
