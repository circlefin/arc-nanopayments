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

/** USDC uses 6 decimals. */
const USDC_DECIMALS = 6;
const USDC_SCALE = BigInt(10) ** BigInt(USDC_DECIMALS);

/** Upper bound on a single withdrawal in atomic micro-units (10,000 USDC). */
const MAX_WITHDRAWAL_USDC_UNITS = BigInt(10_000) * USDC_SCALE;

/** USDC has 6 decimals; reject anything finer or non-decimal. */
const USDC_AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/;

/** EVM address shape, checked before the value is cast to `0x${string}`. */
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Converts a validated decimal string to exact atomic units (micro-USDC).
 */
function toMicroUnits(decimalStr: string): bigint {
  const [whole, frac = ""] = decimalStr.split(".");
  return (
    BigInt(whole) * USDC_SCALE +
    BigInt(frac.padEnd(USDC_DECIMALS, "0").slice(0, USDC_DECIMALS))
  );
}

/**
 * Validates a user-supplied USDC amount using exact integer parsing.
 *
 * Avoids precision loss and float truncation by maintaining the amount as an exact BigInt
 * representation of atomic micro-USDC units throughout threshold comparisons.
 */
function parseAmount(
  value: unknown,
): { amount: string; units: bigint } | { error: string } {
  if (typeof value !== "string" || !USDC_AMOUNT_PATTERN.test(value.trim())) {
    return {
      error:
        "amount must be a positive decimal string with at most 6 decimal places",
    };
  }

  const amount = value.trim();
  const units = toMicroUnits(amount);

  if (units <= 0n) {
    return { error: "amount must be greater than zero" };
  }
  if (units > MAX_WITHDRAWAL_USDC_UNITS) {
    return { error: "amount must not exceed 10000 USDC" };
  }
  return { amount, units };
}

export async function POST(req: NextRequest) {
  // Defence in depth: verify operator session before moving any funds.
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
    destinationAddress: rawDestinationAddress,
  } = body as Record<string, unknown>;

  const parsedAmount = parseAmount(rawAmount);
  if ("error" in parsedAmount) {
    return NextResponse.json({ error: parsedAmount.error }, { status: 400 });
  }
  const { amount, units: withdrawalUnits } = parsedAmount;

  if (
    typeof destinationChain !== "string" ||
    !Object.prototype.hasOwnProperty.call(GATEWAY_DOMAINS, destinationChain)
  ) {
    return NextResponse.json(
      { error: "Unsupported destination chain" },
      { status: 400 },
    );
  }

  if (
    rawDestinationAddress !== undefined &&
    (typeof rawDestinationAddress !== "string" ||
      !EVM_ADDRESS_PATTERN.test(rawDestinationAddress.trim()))
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

  // Explicit recipient semantics: omitting destinationAddress explicitly defaults
  // to self-withdrawal to the seller's gateway address.
  const destinationAddress =
    typeof rawDestinationAddress === "string" && rawDestinationAddress.trim() !== ""
      ? rawDestinationAddress.trim()
      : gateway.address;

  if (!EVM_ADDRESS_PATTERN.test(destinationAddress)) {
    return NextResponse.json(
      { error: "Resolved destination address is not a valid 20-byte hex EVM address" },
      { status: 400 },
    );
  }

  const isCrossChain = destinationChain !== "arcTestnet";

  // Pre-check: ensure the seller wallet has native gas tokens and sufficient balance
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

    // Parse available balance into exact BigInt micro-units to prevent precision mismatch
    const availableUnits = toMicroUnits(
      balances.gateway.formattedAvailable ?? "0",
    );
    if (availableUnits < withdrawalUnits) {
      return NextResponse.json(
        {
          error: `Insufficient gateway balance: ${balances.gateway.formattedAvailable} USDC available, tried to withdraw ${amount} USDC.`,
        },
        { status: 400 },
      );
    }
  } catch (balanceError) {
    // Fail closed: an RPC or gateway outage must abort the withdrawal process.
    console.error("Failed to check balances before withdraw:", balanceError);
    return NextResponse.json(
      {
        error:
          "Unable to verify seller balances before withdrawing. Please retry.",
      },
      { status: 503 },
    );
  }

  // Pre-check: for cross-chain withdrawals, verify gas availability on destination chain
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

  // Record pending withdrawal in database
  const { data: withdrawal, error: insertError } = await supabase
    .from("withdrawals")
    .insert({
      amount_usdc: amount,
      destination_chain: destinationChain,
      destination_address: destinationAddress,
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
      recipient: destinationAddress as `0x${string}`,
    });

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

    await supabase
      .from("withdrawals")
      .update({ status: "failed" })
      .eq("id", withdrawal.id);

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
