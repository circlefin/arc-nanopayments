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
import {
  createClient,
  type SupabaseClient,
} from "@supabase/supabase-js";

const SUPPORTED_CHAIN_LABELS: Record<string, string> = {
  arcTestnet: "Arc Testnet",
  baseSepolia: "Base Sepolia",
  sepolia: "Ethereum Sepolia",
  arbitrumSepolia: "Arbitrum Sepolia",
  optimismSepolia: "Optimism Sepolia",
  avalancheFuji: "Avalanche Fuji",
  polygonAmoy: "Polygon Amoy",
};

type WithdrawalStatus = "submitted" | "confirmed" | "failed";

type WithdrawalInsert = {
  amount_usdc: string;
  destination_chain: string;
  destination_address: string;
  status: WithdrawalStatus;
};

type WithdrawalDatabase = {
  public: {
    Tables: {
      withdrawals: {
        Row: WithdrawalInsert & {
          id: string;
          tx_hash: string | null;
          created_at: string;
        };
        Insert: WithdrawalInsert;
        Update: Partial<WithdrawalInsert> & { tx_hash?: string | null };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

let supabaseClient: SupabaseClient<WithdrawalDatabase> | undefined;

function getSupabaseClient(): SupabaseClient<WithdrawalDatabase> {
  if (supabaseClient) {
    return supabaseClient;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set at runtime",
    );
  }

  // Initialize the client only when a withdrawal request needs persistence.
  supabaseClient = createClient<WithdrawalDatabase>(supabaseUrl, serviceRoleKey);
  return supabaseClient;
}

export async function POST(req: NextRequest) {
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
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Request body must be a JSON object" },
      { status: 400 },
    );
  }

  const { amount, destinationChain, destinationAddress } = body as {
    amount?: unknown;
    destinationChain?: unknown;
    destinationAddress?: unknown;
  };

  if (
    typeof amount !== "string" ||
    typeof destinationChain !== "string" ||
    (destinationAddress !== undefined && typeof destinationAddress !== "string")
  ) {
    return NextResponse.json(
      { error: "amount and destinationChain must be strings" },
      { status: 400 },
    );
  }

  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return NextResponse.json(
      { error: "amount must be a finite positive number" },
      { status: 400 },
    );
  }

  if (
    destinationAddress !== undefined &&
    !/^0x[a-fA-F0-9]{40}$/.test(destinationAddress)
  ) {
    return NextResponse.json(
      { error: "destinationAddress must be a valid EVM address" },
      { status: 400 },
    );
  }

  if (!Object.prototype.hasOwnProperty.call(GATEWAY_DOMAINS, destinationChain)) {
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
    if (availableUsdc < numericAmount) {
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
  const { data: withdrawalRecord, error: insertError } = await getSupabaseClient()
    .from("withdrawals")
    .insert({
      amount_usdc: amount,
      destination_chain: destinationChain,
      destination_address: destinationAddress ?? gateway.address,
      status: "submitted",
    })
    .select()
    .single();

  if (insertError || !withdrawalRecord) {
    return NextResponse.json(
      {
        error: "Failed to record withdrawal" +
          (insertError ? `: ${insertError.message}` : ""),
      },
      { status: 500 },
    );
  }

  const withdrawal = withdrawalRecord as WithdrawalDatabase["public"]["Tables"]["withdrawals"]["Row"];

  try {
    const result = await gateway.withdraw(amount, {
      chain: destinationChain as SupportedChainName,
      recipient: destinationAddress
        ? (destinationAddress as `0x${string}`)
        : undefined,
    });

    // Update the withdrawal record with the transaction hash
    await getSupabaseClient()
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
    await getSupabaseClient()
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
