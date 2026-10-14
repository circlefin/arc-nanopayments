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
import { createHash } from "crypto";

// Arc Testnet contract addresses (from @circle-fin/x402-batching SDK)
const ARC_TESTNET_NETWORK = "eip155:5042002";
const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
const ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

export const sellerAddress = process.env.SELLER_ADDRESS as `0x${string}`;

const facilitator = new BatchFacilitatorClient();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface PaymentPayload {
  x402Version: number;
  resource?: { url: string; description: string; mimeType: string };
  accepted?: Record<string, unknown>;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

function buildPaymentRequirements(price: string) {
  // Parse dollar amount to USDC atomic units (6 decimals)
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

/**
 * Wraps a Next.js route handler with Circle Gateway payment verification.
 *
 * Follows fred-mvp's approach: manually constructs payment requirements with
 * the Gateway batching `extra` field and calls BatchFacilitatorClient directly.
 */
interface IdempotencyRecord {
  transaction: string;
  network: string;
  payer: string;
  timestamp: number;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const idempotencyCache = new Map<string, IdempotencyRecord>();

function getCacheKey(payer: string, endpoint: string): string {
  return createHash("sha256").update(`${payer}:${endpoint}`).digest("hex");
}

function getCachedRecord(cacheKey: string): IdempotencyRecord | null {
  const record = idempotencyCache.get(cacheKey);
  if (!record) return null;
  if (Date.now() - record.timestamp > IDEMPOTENCY_TTL_MS) {
    idempotencyCache.delete(cacheKey);
    return null;
  }
  return record;
}

export function withGateway(
  handler: (req: NextRequest) => Promise<NextResponse>,
  price: string,
  endpoint: string,
) {
  const requirements = buildPaymentRequirements(price);

  return async (req: NextRequest) => {
    const paymentSignature = req.headers.get("payment-signature");
    const idempotencyKey = req.headers.get("idempotency-key");

    // No payment — return 402 with Gateway batching payment requirements
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

    // Payment present — verify and settle via Circle Gateway
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

      const payer = verifyResult.payer ?? "unknown";
      const cacheKey = getCacheKey(payer, endpoint);

      if (idempotencyKey) {
        const cached = getCachedRecord(cacheKey);
        if (cached) {
          console.log(
            `[x402] Idempotent replay: ${endpoint} — returning cached result`,
          );
          const response = await handler(req);
          const settleResponseHeader = Buffer.from(
            JSON.stringify({
              success: true,
              transaction: cached.transaction,
              network: cached.network,
              payer: cached.payer,
              idempotent: true,
            }),
          ).toString("base64");
          response.headers.set("PAYMENT-RESPONSE", settleResponseHeader);
          return response;
        }
      }

      const settleResult = await facilitator.settle(
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

      if (idempotencyKey) {
        idempotencyCache.set(cacheKey, {
          transaction: settleResult.transaction ?? "",
          network: requirements.network,
          payer,
          timestamp: Date.now(),
        });
      }

      // Record payment event in Supabase
      const amountUsdc = (
        Number(requirements.amount) / 1e6
      ).toString();

      const { error } = await supabase.from("payment_events").insert({
        endpoint,
        payer,
        amount_usdc: amountUsdc,
        network: requirements.network,
        gateway_tx: settleResult.transaction ?? null,
        raw: { requirements, settleResult },
      });

      if (error) {
        console.error("Failed to record payment event:", error.message);
      }

      console.log(
        `[x402] Payment settled: ${endpoint} — ${amountUsdc} USDC from ${payer}`,
      );

      // Call the actual route handler
      const response = await handler(req);

      // Forward settlement info to the client
      const settleResponseHeader = Buffer.from(
        JSON.stringify({
          success: true,
          transaction: settleResult.transaction,
          network: requirements.network,
          payer,
        }),
      ).toString("base64");

      response.headers.set("PAYMENT-RESPONSE", settleResponseHeader);
      return response;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error("[x402] Payment processing error:", message);
      return NextResponse.json(
        { error: "Payment processing error", message },
        { status: 500 },
      );
    }
  };
}
