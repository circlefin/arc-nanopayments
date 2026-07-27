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

import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { createClient } from "@supabase/supabase-js";
import { trace } from "@usehaia/trace-x402";
import { createRunWriter } from "@usehaia/trace-core/node";
import { NextRequest, NextResponse } from "next/server";

const ARC_TESTNET_NETWORK = "eip155:5042002";
const TESTNET_FACILITATOR_URL = "https://gateway-api-testnet.circle.com";

export const sellerAddress = process.env.SELLER_ADDRESS as `0x${string}`;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Single middleware instance shared by every paywalled route. It fetches the
// accepted networks / USDC addresses / verifying contract from the facilitator,
// so the manual Arc-specific `extra` block is no longer hardcoded here.
const gateway = createGatewayMiddleware({
  sellerAddress,
  networks: [ARC_TESTNET_NETWORK],
  facilitatorUrl: TESTNET_FACILITATOR_URL,
});

const onTraceError = (err: unknown) =>
  console.warn("[haia-trace] recorder error:", err);
const traceAttestation = trace(gateway, {
  writer: createRunWriter({ dir: ".trace/events", onError: onTraceError }),
  onError: onTraceError,
});
if (!traceAttestation.complete) {
  console.warn(
    "[haia-trace] partial attach — not observing:",
    traceAttestation.missing,
  );
}

gateway.onAfterSettle(async (ctx) => {
  const { requirements, result } = ctx;
  const amountUsdc = (Number(requirements.amount) / 1e6).toString();
  const payer = result.payer ?? "unknown";

  const { error } = await supabase.from("payment_events").insert({
    endpoint: ctx.paymentPayload.resource?.url ?? "unknown",
    payer,
    amount_usdc: amountUsdc,
    network: requirements.network,
    gateway_tx: result.transaction ?? null,
    raw: { requirements, result },
  });
  if (error) {
    console.error("Failed to record payment event:", error.message);
  }
});

gateway.onSettleFailure(async (ctx) => {
  console.error(`Settle failed: ${ctx.error.message}`);
});

/**
 * Adapts the SDK's Express-style Gateway middleware to a Next.js App Router
 * handler. The middleware drives the full x402 lifecycle (402 challenge, verify,
 * settle, hooks); `next()` bridges through to the actual route handler.
 */
export function withGateway(
  handler: (req: NextRequest) => Promise<NextResponse>,
  price: string,
  endpoint: string,
) {
  const middleware = gateway.require(price);

  return async (req: NextRequest): Promise<NextResponse> => {
    const nodeReq = {
      method: req.method,
      // The `resource.url` echoed back to the buyer and used as the Supabase
      // endpoint label comes from here.
      url: endpoint,
      headers: Object.fromEntries(req.headers),
    } as Record<string, unknown>;

    let status = 200;
    const outHeaders = new Headers();
    let outBody = "";
    const nodeRes = {
      statusCode: 200,
      setHeader: (k: string, v: string) => outHeaders.set(k, v),
      end: (b?: string) => {
        outBody = b ?? "";
      },
    };

    let handlerResponse: NextResponse | null = null;
    const next = async () => {
      handlerResponse = await handler(req);
    };

    await (middleware as unknown as (
      req: unknown,
      res: unknown,
      next: () => Promise<void>,
    ) => Promise<void>)(nodeReq, nodeRes, next);
    status = nodeRes.statusCode;

    // Middleware ran the handler via next() — forward its response, merging the
    // middleware-set PAYMENT-RESPONSE header.
    if (handlerResponse) {
      outHeaders.forEach((v, k) => handlerResponse!.headers.set(k, v));
      return handlerResponse;
    }

    // Middleware short-circuited (402 challenge, verification/settlement error).
    return new NextResponse(outBody, { status, headers: outHeaders });
  };
}
