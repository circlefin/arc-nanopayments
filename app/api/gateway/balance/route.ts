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

import { NextResponse } from "next/server";
import { createPublicClient, http, formatUnits, erc20Abi } from "viem";
import { requireSession } from "@/lib/auth";

const GATEWAY_API = "https://gateway-api-testnet.circle.com/v1/balances";
const ARC_TESTNET_DOMAIN = 26;
const ARC_TESTNET_RPC = "https://rpc.testnet.arc.network";
const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;

const publicClient = createPublicClient({
  transport: http(ARC_TESTNET_RPC),
});

async function getWalletUsdcBalance(address: `0x${string}`): Promise<string> {
  try {
    const balance = await publicClient.readContract({
      address: ARC_TESTNET_USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    });
    return formatUnits(balance, 6);
  } catch (error) {
    console.error("Failed to fetch wallet USDC balance:", error);
    return "0";
  }
}

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const address = process.env.SELLER_ADDRESS;
  if (!address) {
    return NextResponse.json(
      { error: "SELLER_ADDRESS not configured" },
      { status: 500 },
    );
  }

  const sellerAddress = address as `0x${string}`;

  try {
    const [gatewayResponse, walletBalance] = await Promise.all([
      fetch(GATEWAY_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          token: "USDC",
          sources: [{ domain: ARC_TESTNET_DOMAIN, depositor: sellerAddress }],
        }),
      }),
      getWalletUsdcBalance(sellerAddress),
    ]);

    if (!gatewayResponse.ok) {
      const text = await gatewayResponse.text();
      console.error("Gateway API error:", gatewayResponse.status, text);
      return NextResponse.json({
        wallet: { balance: walletBalance },
        gateway: {
          total: "0",
          available: "0",
          withdrawing: "0",
          withdrawable: "0",
        },
      });
    }

    const data = await gatewayResponse.json();
    const bal = data.balances?.find(
      (b: { domain: number }) => b.domain === ARC_TESTNET_DOMAIN,
    );

    // Gateway API may return balance as a decimal string or atomic units
    const raw = bal?.balance ?? "0";
    const withdrawingRaw = bal?.withdrawing ?? "0";
    const withdrawableRaw = bal?.withdrawable ?? "0";

    const parse = (v: string) =>
      v.includes(".") ? v : formatUnits(BigInt(v), 6);

    const available = parse(raw);
    const withdrawing = parse(withdrawingRaw);
    const withdrawable = parse(withdrawableRaw);
    const total = (
      parseFloat(available) + parseFloat(withdrawing)
    ).toFixed(6);

    return NextResponse.json({
      wallet: { balance: walletBalance },
      gateway: { total, available, withdrawing, withdrawable },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Balance fetch error:", message);
    return NextResponse.json({
      wallet: { balance: "0" },
      gateway: {
        total: "0",
        available: "0",
        withdrawing: "0",
        withdrawable: "0",
      },
    });
  }
}
