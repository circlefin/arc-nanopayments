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

const SUPPORTED_CHAIN_LABELS: Record<string, string> = {
  arcTestnet: "Arc Testnet",
  baseSepolia: "Base Sepolia",
  sepolia: "Ethereum Sepolia",
  arbitrumSepolia: "Arbitrum Sepolia",
  optimismSepolia: "Optimism Sepolia",
  avalancheFuji: "Avalanche Fuji",
  polygonAmoy: "Polygon Amoy",
};

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function POST(req: NextRequest) {
  const privateKey = process.env.SELLER_PRIVATE_KEY;
  if (!privateKey) {
    return NextResponse.json(
      { error: "SELLER_PRIVATE_KEY not configured" },
      { status: 500 },
    );
  }

  // Optional shared-secret guard. When WITHDRAW_SECRET is set, callers must
  // present it via the x-withdraw-secret header. This endpoint moves the
  // seller's Gateway balance, so it must not be left open in production.
  const withdrawSecret = process.env.WITHDRAW_SECRET;
  if (withdrawSecret) {
    const provided = req.headers.get("x-withdraw-secret");
    if (provided !== withdrawSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const body = await req.json();
  const { amount, destinationChain, destinationAddress } = body as {
    amount: string;
    destinationChain: string;
    destinationAddress?: string;
  };

  if (!amount || !destinationChain) {
    return NextResponse.json(
      { error: "amount and destinationChain are required" },
      { status: 400 },
    );
  }

  if (!(destinationChain in GATEWAY_DOMAINS)) {
    return NextResponse.json(
      { error: `Unsupported chain: ${destinationChain}` },
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
    console.error("Failed to check balances before withdraw:", balanceError);
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
      console.error(
        "Failed to check destination chain gas balance:",
        destBalanceError,
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
