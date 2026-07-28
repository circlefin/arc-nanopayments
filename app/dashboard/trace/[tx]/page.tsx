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

import { Suspense, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, ChevronDown, Loader2 } from "lucide-react";
import { shortenHash } from "@/lib/utils";
import type { TraceEvent } from "@/app/api/trace/[tx]/route";

const EXPLORER_BASE = "https://testnet.arcscan.app";

const EVENT_LABELS: Record<string, string> = {
  "x402.request.protected": "Protected request received",
  "x402.payment.required": "402 challenge issued",
  "x402.payment.creating": "Creating payment payload",
  "x402.payment.submitted": "Payment signed & submitted",
  "x402.payment.creation_failed": "Payment creation failed",
  "x402.payment.responded": "Payment responded (settled)",
  "x402.payment.failed": "Payment failed",
  "x402.payment.canceled": "Verified payment canceled",
  "x402.verify.started": "Verification started",
  "x402.verify.ok": "Verification passed",
  "x402.verify.failed": "Verification failed",
  "x402.settle.started": "Settlement started",
  "x402.settle.ok": "Settlement succeeded",
  "x402.settle.failed": "Settlement failed",
};

function eventTone(type: string): "ok" | "failed" | "neutral" {
  if (type.endsWith(".ok") || type === "x402.payment.responded") return "ok";
  if (type.endsWith(".failed") || type === "x402.payment.canceled")
    return "failed";
  return "neutral";
}

const DOT_CLASS = {
  ok: "bg-emerald-500",
  failed: "bg-destructive",
  neutral: "bg-muted-foreground/40",
} as const;

function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatDelta(ms: number): string {
  if (ms < 1000) return `+${ms}ms`;
  return `+${(ms / 1000).toFixed(2)}s`;
}

type Outcome = "settled" | "failed" | "incomplete";

function deriveOutcome(events: TraceEvent[]): Outcome {
  const types = new Set(events.map((e) => e.event_type));
  if (types.has("x402.settle.ok") || types.has("x402.payment.responded"))
    return "settled";
  if ([...types].some((t) => t.endsWith(".failed") || t.endsWith(".canceled")))
    return "failed";
  return "incomplete";
}

type Summary = {
  endpoint?: string;
  amount?: string;
  network?: string;
  payer?: string;
  date?: string;
};

function summarize(events: TraceEvent[]): Summary {
  const summary: Summary = {};
  for (const e of events) {
    const p = e.payload as
      | {
          payment_required?: { resource?: { url?: string } };
          requirements?: { amount?: string; network?: string };
          settle?: { payer?: string };
        }
      | undefined;
    summary.endpoint ??= p?.payment_required?.resource?.url;
    summary.network ??= p?.requirements?.network;
    summary.payer ??= p?.settle?.payer;
    if (p?.requirements?.amount) {
      summary.amount ??= (Number(p.requirements.amount) / 1e6).toString();
    }
    summary.date ??= e.occurred_at;
  }
  return summary;
}

function EventRow({ event, startMs }: { event: TraceEvent; startMs: number }) {
  const [open, setOpen] = useState(false);
  const tone = eventTone(event.event_type);
  const delta = new Date(event.occurred_at).getTime() - startMs;

  return (
    <li className="relative pl-6 pb-4 last:pb-0 border-l border-border ml-1.5">
      <span
        className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full ${DOT_CLASS[tone]}`}
      />
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium">
          {EVENT_LABELS[event.event_type] ?? event.event_type}
        </span>
        <span className="text-xs text-muted-foreground font-mono">
          {formatTime(event.occurred_at)}
        </span>
        <span className="text-xs text-primary/70 font-mono">
          {formatDelta(delta)}
        </span>
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground font-mono">
        {event.event_type}
      </div>
      {event.payload && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronDown
            size={12}
            className={`transition-transform ${open ? "rotate-180" : ""}`}
          />
          payload
        </button>
      )}
      {open && event.payload && (
        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </li>
  );
}

export default function TracePage() {
  return (
    <Suspense
      fallback={
        <p className="text-muted-foreground text-sm">
          <Loader2 size={16} className="animate-spin inline mr-2" />
          Loading trace...
        </p>
      }
    >
      <TraceView />
    </Suspense>
  );
}

function TraceView() {
  const { tx } = useParams<{ tx: string }>();
  const [events, setEvents] = useState<TraceEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/trace/${encodeURIComponent(tx)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => setEvents(data.events))
      .catch((err) => setError((err as Error).message));
  }, [tx]);

  const summary = events ? summarize(events) : null;
  const sellerEvents = events?.filter((e) => e.role === "server") ?? [];
  const buyerEvents = events?.filter((e) => e.role !== "server") ?? [];
  const outcome = events?.length ? deriveOutcome(events) : null;
  const timesMs = (events ?? []).map((e) => new Date(e.occurred_at).getTime());
  const startMs = timesMs.length ? Math.min(...timesMs) : 0;
  const durationMs = timesMs.length ? Math.max(...timesMs) - startMs : 0;

  return (
    <div className="max-w-4xl mx-auto">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
      >
        <ArrowLeft size={14} />
        Back to dashboard
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold">Payment trace</h1>
        <p className="text-muted-foreground text-sm font-mono break-all">
          {tx}
        </p>
      </div>

      {error ? (
        <p className="text-destructive text-sm">
          Failed to load trace: {error}
        </p>
      ) : events === null ? (
        <p className="text-muted-foreground text-sm">
          <Loader2 size={16} className="animate-spin inline mr-2" />
          Loading trace...
        </p>
      ) : events.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No trace events found for this transaction. Traces only exist for
          payments made while capture was running on this machine.
        </p>
      ) : (
        <>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                Summary
                {outcome && (
                  <Badge
                    variant={
                      outcome === "settled"
                        ? "default"
                        : outcome === "failed"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {outcome}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground text-xs">Endpoint</dt>
                  <dd>
                    <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                      {summary?.endpoint ?? "—"}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Amount</dt>
                  <dd className="font-mono">
                    {summary?.amount ? `$${summary.amount}` : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Payer</dt>
                  <dd className="font-mono text-xs">
                    {summary?.payer ? (
                      <a
                        href={`${EXPLORER_BASE}/address/${summary.payer}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline text-primary"
                      >
                        {shortenHash(summary.payer)}
                      </a>
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Network</dt>
                  <dd className="font-mono text-xs">{summary?.network ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Date</dt>
                  <dd className="text-xs">
                    {summary?.date
                      ? new Date(summary.date).toLocaleString()
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Duration</dt>
                  <dd className="font-mono text-xs">
                    {durationMs ? formatDelta(durationMs).slice(1) : "—"}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Seller
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {sellerEvents.length} events
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {sellerEvents.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No events.</p>
                ) : (
                  <ul>
                    {sellerEvents.map((e) => (
                      <EventRow key={e.event_id} event={e} startMs={startMs} />
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Buyer
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {buyerEvents.length} events
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {buyerEvents.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No events. The buyer writes its own trace; it only appears
                    here when it ran on this machine.
                  </p>
                ) : (
                  <ul>
                    {buyerEvents.map((e) => (
                      <EventRow key={e.event_id} event={e} startMs={startMs} />
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
