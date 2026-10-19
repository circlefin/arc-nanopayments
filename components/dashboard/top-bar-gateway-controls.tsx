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

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GatewayBalanceDialog, type GatewayBalances } from "./gateway-balance-dialog";
import { WithdrawDialog } from "./withdraw-dialog";
import { Info, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import type { RealtimeChannel } from "@supabase/supabase-js";

export function TopBarGatewayControls() {
  const [balances, setBalances] = useState<GatewayBalances | null>(null);
  const [loading, setLoading] = useState(false);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const balancesRef = useRef<GatewayBalances | null>(null);

  const fetchBalances = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/gateway/balance");
      if (res.ok) {
        const next: GatewayBalances = await res.json();
        const prev = balancesRef.current;
        if (prev && prev.gateway.available !== next.gateway.available) {
          toast.success("Gateway balance updated", {
            description: `Available: $${next.gateway.available} USDC`,
          });
        }
        balancesRef.current = next;
        setBalances(next);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("balance-refresh")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "payment_events" },
        () => {
          // Gateway credits the offchain balance immediately, so one refetch is enough.
          fetchBalances();
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "withdrawals" },
        () => {
          fetchBalances();
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          fetchBalances();
        }
      });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchBalances]);

  return (
    <div className="flex flex-1 items-center justify-between gap-3 min-w-0">
      <div className="flex items-center gap-4 min-w-0">
        <span className="font-semibold text-sm truncate">Arc Nanopayments</span>
        <WithdrawDialog
          maxAvailable={balances?.gateway.available ?? "0"}
          onWithdraw={fetchBalances}
        />
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <Badge variant="outline" className="gap-1.5 text-xs pr-1.5">
          <span className="text-muted-foreground font-sans">Gateway:</span>
          <span className="font-mono leading-none translate-y-px inline-flex items-center gap-1">
            {loading && !balances ? <Loader2 size={12} className="animate-spin" /> : null}
            {balances ? `$${balances.gateway.available} USDC` : loading ? "Loading..." : "—"}
          </span>
          <GatewayBalanceDialog
            balances={balances}
            loading={loading}
            onRefresh={fetchBalances}
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 -mr-0.5"
                aria-label="Open gateway balance details"
              >
                <Info size={12} className="text-muted-foreground" />
              </Button>
            }
          />
        </Badge>

      </div>
    </div>
  );
}
