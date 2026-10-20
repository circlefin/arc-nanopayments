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
import { isAddress, parseUnits } from "viem";
import { requireSession } from "@/lib/auth";
import { parseUsdcAmount } from "@/lib/validation";

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
  process.env.SUPABASE_SECRET_KEY!,
);

export async function POST(req: NextRequest) {
  const denied = await requireSession();
  if (denied) return denied;

  const privateKey = process.env.SELLER_PRIVATE_KEY;
  if (!privateKey) {
    return NextResponse.json(
      { error: "SELLER_PRIVATE_KEY not configured" },
      { status: 500 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { destinationChain, destinationAddress } = body as {
    destinationChain?: unknown;
    destinationAddress?: unknown;
  };

  const parsedAmount = parseUsdcAmount((body as { amount?: unknown }).amount);
  if (!parsedAmount) {
    return NextResponse.json(
      {
        error:
          "amount must be a positive USDC amount with at most 6 decimal places",
      },
      { status: 400 },
    );
  }
  const amount = parsedAmount.value;

  if (typeof destinationChain !== "string" || !destinationChain) {
    return NextResponse.json(
      { error: "amount and destinationChain are required" },
      { status: 400 },
    );
  }

  // hasOwn, not `in`: "constructor" and "toString" are `in` every object.
  if (!Object.hasOwn(GATEWAY_DOMAINS, destinationChain)) {
    return NextResponse.json(
      { error: `Unsupported chain: ${destinationChain}` },
      { status: 400 },
    );
  }

  if (
    destinationAddress !== undefined &&
    (typeof destinationAddress !== "string" ||
      !isAddress(destinationAddress, { strict: false }))
  ) {
    return NextResponse.json(
      { error: "destinationAddress must be a valid 0x address" },
      { status: 400 },
    );
  }

  const gateway = new GatewayClient({
    chain: "arcTestnet",
    privateKey: privateKey as `0x${string}`,
  });

  const isCrossChain = destinationChain !== "arcTestnet";

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

    const availableMicro = parseUnits(balances.gateway.formattedAvailable, 6);
    if (availableMicro < parsedAmount.micro) {
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

  const { data: withdrawal, error: insertError } = await supabase
    .from("withdrawals")
    .insert({
      amount_usdc: amount,
      destination_chain: destinationChain,
      destination_address: (destinationAddress as string | undefined) ?? gateway.address,
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

    // Update the withdrawal record with the transaction hash. The funds have
    // already moved, so a failure here must be loud but must not fail the request.
    const { error: confirmError } = await supabase
      .from("withdrawals")
      .update({ status: "confirmed", tx_hash: result.mintTxHash })
      .eq("id", withdrawal.id);
    if (confirmError) {
      console.error(
        `CRITICAL: withdrawal ${withdrawal.id} succeeded (${result.mintTxHash}) but could not be marked confirmed:`,
        confirmError.message,
      );
    }

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

    const { error: failError } = await supabase
      .from("withdrawals")
      .update({ status: "failed" })
      .eq("id", withdrawal.id);
    if (failError) {
      console.error(
        `Withdrawal ${withdrawal.id} failed and could not be marked failed:`,
        failError.message,
      );
    }

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
