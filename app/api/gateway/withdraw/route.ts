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

import { NextRequest, NextResponse } from "next/server";
import {
  GatewayClient,
  type SupportedChainName,
  GATEWAY_DOMAINS,
} from "@circle-fin/x402-batching/client";
import { createClient } from "@supabase/supabase-js";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

const SUPPORTED_CHAIN_LABELS: Record<string, string> = {
  arcTestnet: "Arc Testnet",
  baseSepolia: "Base Sepolia",
  sepolia: "Ethereum Sepolia",
  arbitrumSepolia: "Arbitrum Sepolia",
  optimismSepolia: "Optimism Sepolia",
  avalancheFuji: "Avalanche Fuji",
  polygonAmoy: "Polygon Amoy",
};

/** Upper bound on a single withdrawal, in whole USDC. */
const MAX_WITHDRAWAL_USDC = 10_000;

/** USDC has 6 decimals; reject anything finer than that. */
const USDC_AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/;

/** EVM address shape, checked before the value is cast to `0x${string}`. */
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Validates a user-supplied USDC amount.
 *
 * The amount is kept as a decimal string and validated by pattern rather than
 * parsed through `Number`, so no precision is lost before it reaches the SDK.
 */
function parseAmount(value: unknown): { amount: string } | { error: string } {
  if (typeof value !== "string" || !USDC_AMOUNT_PATTERN.test(value.trim())) {
    return {
      error:
        "amount must be a positive decimal string with at most 6 decimal places",
    };
  }

  const amount = value.trim();
  if (Number(amount) <= 0) {
    return { error: "amount must be greater than zero" };
  }
  if (Number(amount) > MAX_WITHDRAWAL_USDC) {
    return { error: `amount must not exceed ${MAX_WITHDRAWAL_USDC} USDC` };
  }
  return { amount };
}

export async function POST(req: NextRequest) {
  // Defence in depth: `middleware.ts` already gates /api/gateway/*, but this
  // handler moves funds, so it re-checks the operator session itself rather
  // than trusting an upstream matcher to stay correct.
  const session = await verifySessionToken(
    req.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const privateKey = process.env.SELLER_PRIVATE_KEY;
  if (!privateKey) {
    return NextResponse.json(
      { error: "SELLER_PRIVATE_KEY not configured" },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json(
      { error: "Request body must be a JSON object" },
      { status: 400 },
    );
  }

  const {
    amount: rawAmount,
    destinationChain,
    destinationAddress,
  } = body as Record<string, unknown>;

  const parsedAmount = parseAmount(rawAmount);
  if ("error" in parsedAmount) {
    return NextResponse.json({ error: parsedAmount.error }, { status: 400 });
  }
  const amount = parsedAmount.amount;

  if (
    typeof destinationChain !== "string" ||
    !Object.prototype.hasOwnProperty.call(GATEWAY_DOMAINS, destinationChain)
  ) {
    // `hasOwnProperty` rather than `in`, so inherited keys such as
    // "constructor" or "toString" cannot pass the allowlist check.
    return NextResponse.json(
      { error: "Unsupported destination chain" },
      { status: 400 },
    );
  }

  if (
    destinationAddress !== undefined &&
    (typeof destinationAddress !== "string" ||
      !EVM_ADDRESS_PATTERN.test(destinationAddress))
  ) {
    return NextResponse.json(
      { error: "destinationAddress must be a 20-byte hex EVM address" },
      { status: 400 },
    );
  }

  const gateway = new GatewayClient({
    chain: "arcTestnet",
    privateKey: privateKey as `0x${string}`,
  });

  const isCrossChain = destinationChain !== "arcTestnet";

  // Pre-check: ensure the seller wallet has native tokens for gas on source chain
  try {
    const balances = await gateway.getBalances();
    if (
      !balances.wallet.formatted ||
      Number(balances.wallet.formatted) === 0
    ) {
      return NextResponse.json(
        {
          error: `Seller wallet (${gateway.address}) has no native tokens on Arc Testnet to pay for gas fees. Fund it with testnet ETH first.`,
        },
        { status: 400 },
      );
    }

    const availableUsdc = Number(balances.gateway.formattedAvailable);
    if (availableUsdc < Number(amount)) {
      return NextResponse.json(
        {
          error: `Insufficient gateway balance: ${balances.gateway.formattedAvailable} USDC available, tried to withdraw ${amount} USDC.`,
        },
        { status: 400 },
      );
    }
  } catch (balanceError) {
    // Fail closed. Previously this branch only logged and then continued to the
    // withdrawal, so an RPC/Gateway outage turned the "sufficient balance" and
    // "sufficient gas" pre-checks into no-ops.
    console.error("Failed to check balances before withdraw:", balanceError);
    return NextResponse.json(
      {
        error:
          "Unable to verify seller balances before withdrawing. Please retry.",
      },
      { status: 503 },
    );
  }

  // Pre-check: for cross-chain withdrawals, verify gas on the destination chain
  if (isCrossChain) {
    try {
      const destGateway = new GatewayClient({
        chain: destinationChain as SupportedChainName,
        privateKey: privateKey as `0x${string}`,
      });
      const destBalances = await destGateway.getBalances();
      if (
        !destBalances.wallet.formatted ||
        Number(destBalances.wallet.formatted) === 0
      ) {
        const chainLabel =
          SUPPORTED_CHAIN_LABELS[destinationChain] ?? destinationChain;
        return NextResponse.json(
          {
            error: `Seller wallet (${destGateway.address}) has no native tokens on ${chainLabel} to pay for the mint transaction gas fees. Fund it with testnet ETH on ${chainLabel} first.`,
          },
          { status: 400 },
        );
      }
    } catch (destBalanceError) {
      // Fail closed for the same reason as the source-chain pre-check above:
      // a failed lookup is not evidence that the destination chain is funded.
      console.error(
        "Failed to check destination chain gas balance:",
        destBalanceError,
      );
      return NextResponse.json(
        {
          error:
            "Unable to verify destination chain gas balance. Please retry.",
        },
        { status: 503 },
      );
    }
  }

  // Insert a pending withdrawal record
  const { data: withdrawal, error: insertError } = await supabase
    .from("withdrawals")
    .insert({
      amount_usdc: amount,
      destination_chain: destinationChain,
      destination_address: destinationAddress ?? gateway.address,
      status: "submitted",
    })
    .select()
    .single();

  if (insertError) {
    return NextResponse.json(
      { error: "Failed to record withdrawal: " + insertError.message },
      { status: 500 },
    );
  }

  try {
    const result = await gateway.withdraw(amount, {
      chain: destinationChain as SupportedChainName,
      recipient: destinationAddress
        ? (destinationAddress as `0x${string}`)
        : undefined,
    });

    // Update the withdrawal record with the transaction hash
    await supabase
      .from("withdrawals")
      .update({ status: "confirmed", tx_hash: result.mintTxHash })
      .eq("id", withdrawal.id);

    return NextResponse.json({
      id: withdrawal.id,
      txHash: result.mintTxHash,
      amount: result.formattedAmount,
      sourceChain: result.sourceChain,
      destinationChain: result.destinationChain,
      recipient: result.recipient,
      status: "confirmed",
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);

    // Mark withdrawal as failed
    await supabase
      .from("withdrawals")
      .update({ status: "failed" })
      .eq("id", withdrawal.id);

    // Translate common on-chain errors into user-friendly messages
    const chainLabel =
      SUPPORTED_CHAIN_LABELS[destinationChain] ?? destinationChain;
    let message = raw;
    if (
      raw.includes("insufficient funds for gas") ||
      raw.includes("exceeds the balance of the account") ||
      raw.includes("gas required exceeds allowance")
    ) {
      message = isCrossChain
        ? `Seller wallet (${gateway.address}) has no native tokens on ${chainLabel} to pay for the CCTP mint transaction. Fund it with testnet ETH on ${chainLabel} and retry.`
        : `Seller wallet has insufficient native tokens to pay for gas. Fund ${gateway.address} with testnet ETH and retry.`;
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
