/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isAddress } from "viem";
import { requireSession } from "@/lib/auth";
import { isUuid, paymentLookup, transferSnapshot } from "@/lib/payment-settlement";

function error(status: number, code: string, message: string) {
  return NextResponse.json({ code, error: message }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireSession();
  if (denied) {
    denied.headers.set("Cache-Control", "no-store");
    return denied;
  }

  const { id } = await context.params;
  if (!isUuid(id)) return error(400, "invalid_event_id", "Invalid payment record ID.");

  const seller = process.env.SELLER_ADDRESS;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!seller || !isAddress(seller, { strict: false }) || !url || !key) {
    return error(500, "lookup_unavailable", "Settlement lookup is not configured.");
  }

  let record;
  try {
    const supabase = createClient(url, key);
    const { data, error: queryError } = await supabase.from("payment_events")
      .select("id,gateway_tx,network,payer,raw").eq("id", id).maybeSingle();
    if (queryError) throw queryError;
    record = data;
  } catch {
    return error(500, "lookup_unavailable", "Could not read this payment record.");
  }
  if (!record) return error(404, "payment_not_found", "Payment record not found.");

  const expected = paymentLookup(record, seller);
  if (expected.error) {
    return expected.error === "payment_not_found"
      ? error(404, expected.error, "Payment record not found.")
      : error(409, expected.error, "Settlement lookup is unavailable for this record.");
  }

  // Covers headers and body consumption; never follow a redirect to another request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(
      `https://gateway-api-testnet.circle.com/v1/x402/transfers/${encodeURIComponent(expected.transferId)}`,
      { method: "GET", cache: "no-store", redirect: "error", signal: controller.signal },
    );
    if (response.status === 404) {
      return error(404, "transfer_not_found", "Gateway did not return this transfer. This does not establish payment failure.");
    }
    if (!response.ok) {
      return error(503, "lookup_unavailable", "Could not check settlement. Please try again.");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (controller.signal.aborted) throw new Error("Lookup timed out");
      return error(502, "invalid_gateway_response", "Could not validate Gateway's response for this payment.");
    }
    const snapshot = transferSnapshot(body, expected, id);
    if (controller.signal.aborted) throw new Error("Lookup timed out");
    return snapshot
      ? NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } })
      : error(502, "invalid_gateway_response", "Could not validate Gateway's response for this payment.");
  } catch {
    return controller.signal.aborted
      ? error(504, "lookup_timeout", "Settlement lookup timed out. Please try again.")
      : error(503, "lookup_unavailable", "Could not check settlement. Please try again.");
  } finally {
    clearTimeout(timer);
  }
}
