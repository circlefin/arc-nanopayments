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

/** USDC has 6 decimals. */
const USDC_DECIMALS = 6;

/**
 * 10^6 as a bigint. Written with `BigInt(...)` rather than a `10n` literal
 * because this project compiles with `target: "ES2017"`, under which BigInt
 * literals are a type error.
 */
const USDC_SCALE = BigInt(10) ** BigInt(USDC_DECIMALS);
const ZERO = BigInt(0);

/** `$1.23`, `1.23`, `$0.005` — up to 6 decimal places, no exponent notation. */
const PRICE_PATTERN = /^\$?(\d+)(?:\.(\d{1,6}))?$/;

/**
 * Converts a price string such as `"$0.03"` into USDC atomic units.
 *
 * The previous implementation used `Math.round(parseFloat(price) * 1_000_000)`,
 * which routed a monetary value through binary floating point and silently
 * produced `NaN` for a malformed price. This version parses the integer and
 * fractional parts as digits, so the conversion is exact, and throws on input
 * it cannot represent rather than emitting `"NaN"` as an on-chain amount.
 *
 * @throws if `price` is not a plain decimal amount with at most 6 decimals.
 */
export function priceToAtomicUnits(price: string): bigint {
  const match = PRICE_PATTERN.exec(price.trim());
  if (!match) {
    throw new Error(
      `Invalid price "${price}": expected a decimal amount with at most ${USDC_DECIMALS} decimal places.`,
    );
  }

  const whole = match[1] ?? "0";
  // Right-pad the fractional digits so "0.5" and "0.500000" agree.
  const fraction = (match[2] ?? "").padEnd(USDC_DECIMALS, "0");
  const atomic = BigInt(whole) * USDC_SCALE + BigInt(fraction);

  if (atomic <= ZERO) {
    throw new Error(`Invalid price "${price}": amount must be greater than zero.`);
  }
  return atomic;
}

/** Formats atomic USDC units back to a decimal string without floating point. */
function formatAtomicUnits(atomic: bigint): string {
  const whole = atomic / USDC_SCALE;
  const fraction = (atomic % USDC_SCALE).toString().padStart(USDC_DECIMALS, "0");
  return `${whole}.${fraction}`;
}

function buildPaymentRequirements(price: string) {
  const amount = priceToAtomicUnits(price);

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
export function withGateway(
  handler: (req: NextRequest) => Promise<NextResponse>,
  price: string,
  endpoint: string,
) {
  const requirements = buildPaymentRequirements(price);

  return async (req: NextRequest) => {
    const paymentSignature = req.headers.get("payment-signature");

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

      // Record payment event in Supabase
      const amountUsdc = formatAtomicUnits(BigInt(requirements.amount));
      const payer = settleResult.payer ?? verifyResult.payer ?? "unknown";

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

      // Settlement has already moved funds. A handler failure past this point is
      // a *fulfilment* failure, not a payment failure, and must be reported and
      // logged as such so the paid-but-unfulfilled call can be reconciled —
      // previously it surfaced as a generic "Payment processing error".
      let response: NextResponse;
      try {
        response = await handler(req);
      } catch (handlerError) {
        console.error(
          `[x402] PAID BUT UNFULFILLED — endpoint=${endpoint} payer=${payer} amount=${amountUsdc} tx=${
            settleResult.transaction ?? "unknown"
          }:`,
          handlerError instanceof Error ? handlerError.message : String(handlerError),
        );
        return NextResponse.json(
          {
            error: "Payment settled but the resource could not be produced",
            transaction: settleResult.transaction ?? null,
          },
          { status: 500 },
        );
      }

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
      // Log the detail server-side, but do not echo internal error text back to
      // the caller: these messages can carry facilitator internals and payload
      // fragments.
      console.error("[x402] Payment processing error:", message);
      return NextResponse.json(
        { error: "Payment processing error" },
        { status: 500 },
      );
    }
  };
}
