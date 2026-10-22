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

import { useCallback, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Loader2,
} from "lucide-react";
import { shortenHash } from "@/lib/utils";
import { usePaymentEvents } from "@/hooks/use-transactions";
import { useWithdrawals } from "@/hooks/use-withdrawals";

type SortDirection = "default" | "asc" | "desc";
type SortField = "amount" | "date";

const EXPLORER_BASE = "https://testnet.arcscan.app";

function nextSortDirection(current: SortDirection): SortDirection {
  if (current === "default") return "asc";
  if (current === "asc") return "desc";
  return "default";
}

function SortIcon({ direction }: { direction: SortDirection }) {
  if (direction === "asc") return <ArrowUp size={14} />;
  if (direction === "desc") return <ArrowDown size={14} />;
  return <ArrowUpDown size={14} className="text-muted-foreground/50" />;
}

function parseAmount(amount: string): number {
  return parseFloat(amount.replace(/,/g, ""));
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CopyableCell({
  value,
  label,
  href,
}: {
  value: string;
  label?: string;
  href?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);

  return (
    <span className="inline-flex items-center gap-1.5">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline text-primary"
        >
          {label ?? value}
        </a>
      ) : (
        <span>{label ?? value}</span>
      )}
      <Tooltip open={copied || undefined}>
        <TooltipTrigger asChild>
          <button
            onClick={handleCopy}
            className="text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
          >
            <Copy size={12} />
          </button>
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied!" : "Copy"}</TooltipContent>
      </Tooltip>
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "confirmed"
      ? "default"
      : status === "failed"
        ? "destructive"
        : "secondary";
  return <Badge variant={variant}>{status}</Badge>;
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export default function Dashboard() {
  const { events, loading: loadingPayments } = usePaymentEvents();
  const { withdrawals, loading: loadingWithdrawals } = useWithdrawals();
  const [activeTab, setActiveTab] = useState("payments");
  const [filter, setFilter] = useState("");
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("default");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(10);

  function handleSort(field: SortField) {
    if (sortField === field) {
      const next = nextSortDirection(sortDirection);
      setSortDirection(next);
      if (next === "default") setSortField(null);
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
    setPage(1);
  }

  const filteredPayments = useMemo(() => {
    let result = events;

    if (filter) {
      const query = filter.toLowerCase();
      result = result.filter(
        (ev) =>
          (ev.gateway_tx ?? "").toLowerCase().includes(query) ||
          ev.payer.toLowerCase().includes(query) ||
          ev.endpoint.toLowerCase().includes(query),
      );
    }

    if (sortField && sortDirection !== "default") {
      result = [...result].sort((a, b) => {
        let cmp: number;
        if (sortField === "amount") {
          cmp = parseAmount(a.amount_usdc) - parseAmount(b.amount_usdc);
        } else {
          cmp = a.created_at.localeCompare(b.created_at);
        }
        return sortDirection === "desc" ? -cmp : cmp;
      });
    }

    return result;
  }, [events, filter, sortField, sortDirection]);

  const filteredWithdrawals = useMemo(() => {
    let result = withdrawals;

    if (filter) {
      const query = filter.toLowerCase();
      result = result.filter(
        (w) =>
          (w.tx_hash ?? "").toLowerCase().includes(query) ||
          w.destination_address.toLowerCase().includes(query) ||
          w.destination_chain.toLowerCase().includes(query) ||
          w.status.toLowerCase().includes(query),
      );
    }

    if (sortField && sortDirection !== "default") {
      result = [...result].sort((a, b) => {
        let cmp: number;
        if (sortField === "amount") {
          cmp = parseAmount(a.amount_usdc) - parseAmount(b.amount_usdc);
        } else {
          cmp = a.created_at.localeCompare(b.created_at);
        }
        return sortDirection === "desc" ? -cmp : cmp;
      });
    }

    return result;
  }, [withdrawals, filter, sortField, sortDirection]);

  const activeData = activeTab === "payments" ? filteredPayments : filteredWithdrawals;
  const loading = activeTab === "payments" ? loadingPayments : loadingWithdrawals;
  const totalPages = Math.max(1, Math.ceil(activeData.length / pageSize));

  // Clamp page if data shrinks (e.g. realtime delete)
  const clampedPage = Math.min(page, totalPages);

  const paginatedPayments = useMemo(() => {
    const start = (clampedPage - 1) * pageSize;
    return filteredPayments.slice(start, start + pageSize);
  }, [filteredPayments, clampedPage, pageSize]);

  const paginatedWithdrawals = useMemo(() => {
    const start = (clampedPage - 1) * pageSize;
    return filteredWithdrawals.slice(start, start + pageSize);
  }, [filteredWithdrawals, clampedPage, pageSize]);

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Welcome back!</h1>
        <p className="text-muted-foreground text-sm">
          Monitor incoming nanopayments and manage withdrawals.
        </p>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <Input
          placeholder={
            activeTab === "payments"
              ? "Filter by tx hash, payer, or endpoint..."
              : "Filter by tx hash, address, chain, or status..."
          }
          className="max-w-xs"
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setPage(1); }}
        />
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-sm text-muted-foreground whitespace-nowrap">Rows per page</span>
          <Select
            value={String(pageSize)}
            onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}
          >
            <SelectTrigger size="sm" className="w-[70px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          setActiveTab(v);
          setFilter("");
          setPage(1);
          setSortField(null);
          setSortDirection("default");
        }}
      >
        <TabsList className="w-full">
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="withdrawals">Withdrawals</TabsTrigger>
        </TabsList>

        <TabsContent value="payments">
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Transaction</TableHead>
                  <TableHead>Payer</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead className="text-right">
                    <button
                      className="inline-flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
                      onClick={() => handleSort("amount")}
                    >
                      Amount (USDC)
                      <SortIcon
                        direction={sortField === "amount" ? sortDirection : "default"}
                      />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                      onClick={() => handleSort("date")}
                    >
                      Date
                      <SortIcon direction={sortField === "date" ? sortDirection : "default"} />
                    </button>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingPayments ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="h-24 text-center text-muted-foreground"
                    >
                      <Loader2 size={16} className="animate-spin inline mr-2" />
                      Loading payments...
                    </TableCell>
                  </TableRow>
                ) : paginatedPayments.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="h-24 text-center text-muted-foreground"
                    >
                      No payments found.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedPayments.map((ev) => (
                    <TableRow key={ev.id}>
                      <TableCell className="font-mono text-xs">
                        {ev.gateway_tx ? (
                          <CopyableCell
                            value={ev.gateway_tx}
                            label={shortenHash(ev.gateway_tx, 6)}
                            href={
                              ev.gateway_tx.startsWith("0x")
                                ? `${EXPLORER_BASE}/tx/${ev.gateway_tx}`
                                : undefined
                            }
                          />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <CopyableCell
                          value={ev.payer}
                          label={shortenHash(ev.payer)}
                          href={`${EXPLORER_BASE}/address/${ev.payer}`}
                        />
                      </TableCell>
                      <TableCell className="text-xs">
                        <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                          {ev.endpoint}
                        </code>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        ${ev.amount_usdc}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatDate(ev.created_at)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="withdrawals">
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Transaction</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Chain</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">
                    <button
                      className="inline-flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
                      onClick={() => handleSort("amount")}
                    >
                      Amount (USDC)
                      <SortIcon
                        direction={sortField === "amount" ? sortDirection : "default"}
                      />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                      onClick={() => handleSort("date")}
                    >
                      Date
                      <SortIcon direction={sortField === "date" ? sortDirection : "default"} />
                    </button>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingWithdrawals ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="h-24 text-center text-muted-foreground"
                    >
                      <Loader2 size={16} className="animate-spin inline mr-2" />
                      Loading withdrawals...
                    </TableCell>
                  </TableRow>
                ) : paginatedWithdrawals.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="h-24 text-center text-muted-foreground"
                    >
                      No withdrawals found.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedWithdrawals.map((w) => (
                    <TableRow key={w.id}>
                      <TableCell className="font-mono text-xs">
                        {w.tx_hash ? (
                          <CopyableCell
                            value={w.tx_hash}
                            label={shortenHash(w.tx_hash, 6)}
                            href={
                              w.tx_hash.startsWith("0x")
                                ? `${EXPLORER_BASE}/tx/${w.tx_hash}`
                                : undefined
                            }
                          />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <CopyableCell
                          value={w.destination_address}
                          label={shortenHash(w.destination_address)}
                          href={`${EXPLORER_BASE}/address/${w.destination_address}`}
                        />
                      </TableCell>
                      <TableCell className="text-xs">
                        <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                          {w.destination_chain}
                        </code>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={w.status} />
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        ${w.amount_usdc}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatDate(w.created_at)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>

      {/* Shared pagination controls */}
      {!loading && activeData.length > 0 && (
        <div className="flex items-center justify-between border-x border-b rounded-b-lg px-4 py-3 text-sm">
          <span className="text-muted-foreground">
            {activeData.length} {activeTab === "payments" ? "transaction" : "withdrawal"}{activeData.length !== 1 ? "s" : ""} total
          </span>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              Page {clampedPage} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={clampedPage <= 1}
              className="inline-flex items-center justify-center rounded-md border h-8 w-8 disabled:opacity-30 hover:bg-muted transition-colors"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={clampedPage >= totalPages}
              className="inline-flex items-center justify-center rounded-md border h-8 w-8 disabled:opacity-30 hover:bg-muted transition-colors"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
