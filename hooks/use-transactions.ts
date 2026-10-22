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

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

export type PaymentEvent = {
  id: string;
  created_at: string;
  endpoint: string;
  payer: string;
  amount_usdc: string;
  network: string;
  gateway_tx: string | null;
  raw: Record<string, unknown> | null;
};

export function usePaymentEvents() {
  const [events, setEvents] = useState<PaymentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    const supabase = createClient();

    async function fetchInitial() {
      const { data, error } = await supabase
        .from("payment_events")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Failed to fetch payment events:", error.message);
      } else {
        setEvents((prev) => {
          if (prev.length === 0) return data as PaymentEvent[];
          const fetched = data as PaymentEvent[];
          const existingIds = new Set(fetched.map((e) => e.id));
          const realtimeOnly = prev.filter((e) => !existingIds.has(e.id));
          return [...realtimeOnly, ...fetched];
        });
      }
      setLoading(false);
    }

    const channel = supabase
      .channel("payment-events-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "payment_events" },
        (payload) => {
          setEvents((prev) => {
            const newEvent = payload.new as PaymentEvent;
            if (prev.some((ev) => ev.id === newEvent.id)) return prev;
            return [newEvent, ...prev];
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "payment_events" },
        (payload) => {
          setEvents((prev) =>
            prev.map((ev) =>
              ev.id === (payload.new as PaymentEvent).id
                ? (payload.new as PaymentEvent)
                : ev,
            ),
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "payment_events" },
        (payload) => {
          setEvents((prev) =>
            prev.filter(
              (ev) => ev.id !== (payload.old as { id: string }).id,
            ),
          );
        },
      )
      .subscribe((status) => {
        // Fetch only once the subscription is live, so no events are missed.
        if (status === "SUBSCRIBED") {
          fetchInitial();
        }
      });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return { events, loading };
}
