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

import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import type { ResourceOutcome } from "@/lib/resource-outcome";

// Arc Testnet contract addresses (from @circle-fin/x402-batching SDK)
const ARC_TESTNET_NETWORK = "eip155:5042002";
const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
const ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

/** The seller wallet that receives payments, or null if SELLER_ADDRESS is missing or malformed. */
function getSellerAddress(): `0x${string}` | null {
  const address = process.env.SELLER_ADDRESS;
  return address && isAddress(address, { strict: false })
    ? (address as `0x${string}`)
    : null;
}

const facilitator = new BatchFacilitatorClient();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
);

/** Execute a PostgREST thenable once; abort is not proof the write was rolled back. */
async function observeWrite<T>(
  operation: (signal: AbortSignal) => PromiseLike<T>,
): Promise<T | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          resolve(undefined);
          controller.abort();
        }, 2000);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PaymentPayload {
  x402Version: number;
  resource?: { url: string; description: string; mimeType: string };
  accepted?: Record<string, unknown>;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

function buildPaymentRequirements(price: string, sellerAddress: `0x${string}`) {
  const amount = Math.round(parseFloat(price.replace("$", "")) * 1_000_000);

  return {
    scheme: "exact" as const,
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount: amount.toString(),
    payTo: sellerAddress,
    maxTimeoutSeconds: 345600,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: ARC_TESTNET_GATEWAY_WALLET,
    },
  };
}

// Wraps a route handler with Circle Gateway payment verification.
export function withGateway(
  handler: (req: NextRequest) => Promise<NextResponse>,
  price: string,
  endpoint: string,
) {
  return async (req: NextRequest) => {
    // Resolved per request so a missing SELLER_ADDRESS is a clear 500, never a
    // payment addressed to "undefined".
    const sellerAddress = getSellerAddress();
    if (!sellerAddress) {
      console.error("[x402] SELLER_ADDRESS is missing or not a valid address");
      return NextResponse.json(
        { error: "Payment receiver is not configured" },
        { status: 500 },
      );
    }
    const requirements = buildPaymentRequirements(price, sellerAddress);

    const paymentSignature = req.headers.get("payment-signature");

    if (!paymentSignature) {
      console.log(`[x402] 402 Payment Required: ${endpoint}`);

      const paymentRequired = {
        x402Version: 2,
        resource: {
          url: endpoint,
          description: `Paid resource (${price} USDC)`,
          mimeType: "application/json",
        },
        accepts: [requirements],
      };

      return new NextResponse(JSON.stringify({}), {
        status: 402,
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-REQUIRED": Buffer.from(
            JSON.stringify(paymentRequired),
          ).toString("base64"),
        },
      });
    }

    let settleResult: Awaited<ReturnType<typeof facilitator.settle>>;
    let payer: string;
    try {
      const paymentPayload: PaymentPayload = JSON.parse(
        Buffer.from(paymentSignature, "base64").toString("utf-8"),
      );

      const verifyResult = await facilitator.verify(
        paymentPayload,
        requirements,
      );

      if (!verifyResult.isValid) {
        return NextResponse.json(
          {
            error: "Payment verification failed",
            reason: verifyResult.invalidReason,
          },
          { status: 402 },
        );
      }

      settleResult = await facilitator.settle(
        paymentPayload,
        requirements,
      );

      if (!settleResult.success) {
        console.error(
          `[x402] Settlement failed for ${endpoint}: ${settleResult.errorReason}`,
        );
        return NextResponse.json(
          {
            error: "Payment settlement failed",
            reason: settleResult.errorReason,
          },
          { status: 402 },
        );
      }

      payer = settleResult.payer ?? verifyResult.payer ?? "unknown";
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error("[x402] Payment processing error:", message);
      return NextResponse.json(
        { error: "Payment processing error" },
        { status: 500 },
      );
    }

    // Gateway acceptance is known from here onward. Observation/storage failures
    // cannot turn it into an unpaid response or prevent resource processing.
    const acknowledgement = Buffer.from(
      JSON.stringify({
        success: true,
        transaction: settleResult.transaction,
        network: requirements.network,
        payer,
      }),
    ).toString("base64");
    const raw = { requirements, settleResult };
    const inserted = await observeWrite((signal) =>
      supabase.from("payment_events").insert({
        endpoint,
        payer,
        amount_usdc: (Number(requirements.amount) / 1e6).toString(),
        network: requirements.network,
        gateway_tx: settleResult.transaction ?? null,
        raw,
      }).select("id").abortSignal(signal).retry(false).single<{ id: string }>(),
    );
    const id = !inserted?.error &&
      typeof inserted?.data?.id === "string" && EVENT_ID.test(inserted.data.id)
      ? inserted.data.id
      : undefined;
    if (!id) console.error("[x402] Accepted payment observation unavailable.");

    let response: NextResponse;
    let outcome: ResourceOutcome;
    try {
      response = await handler(req);
      outcome = { kind: "response", httpStatus: response.status };
    } catch {
      // Keep known payment acceptance distinct from a resource failure.
      console.error(`[x402] Resource handler failed after acceptance: ${endpoint}`);
      response = NextResponse.json(
        {
          error: "Payment accepted, but the resource could not be produced",
          transaction: settleResult.transaction ?? null,
        },
        { status: 500 },
      );
      outcome = { kind: "handler_error", httpStatus: 500 };
    }
    response.headers.set("PAYMENT-RESPONSE", acknowledgement);
    if (id) {
      const updated = await observeWrite((signal) =>
        supabase.from("payment_events")
          .update({ raw: { ...raw, resourceOutcome: outcome } })
          .eq("id", id).abortSignal(signal).retry(false),
      );
      if (!updated || updated.error) console.error("[x402] Resource observation unavailable.");
    }
    console.log(`[x402] Payment accepted: ${endpoint}`);
    return response;
  };
}
