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
import { isAddress } from "viem";
import { boundedText, object } from "@/lib/buyer/http";
import { DOMAIN, NETWORK, sameAddress, usdcAtomic, usdcDisplay } from "@/lib/buyer/network";

const headers = { "Cache-Control": "no-store" };

// Public chain data only. This route never imports seller auth, a database client
// or a signing client, and accepts no caller-supplied URL or network.
export async function GET(request: NextRequest) {
  const entries = [...request.nextUrl.searchParams.entries()];
  const address = request.nextUrl.searchParams.get("address");
  if (entries.length !== 1 || entries[0][0] !== "address" || !address || !isAddress(address, { strict: false })) {
    return NextResponse.json({ error: "Supply exactly one EVM address." }, { status: 400, headers });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch("https://gateway-api-testnet.circle.com/v1/balances", {
      method: "POST", redirect: "error", cache: "no-store", signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "USDC", sources: [{ domain: DOMAIN, depositor: address }] }),
    });
    if (!response.ok) throw new Error("Gateway unavailable");
    const data: unknown = JSON.parse(await boundedText(response));
    if (!object(data) || (data.token !== undefined && data.token !== "USDC") || !Array.isArray(data.balances)) throw new Error("Invalid balance response");
    const matches = data.balances.filter((value: unknown) => object(value) && value.domain === DOMAIN);
    if (matches.length !== 1 || !object(matches[0])) throw new Error("Missing balance");
    const balance = matches[0];
    if (balance.depositor !== undefined && !sameAddress(balance.depositor, address)) throw new Error("Wrong depositor");
    const available = usdcAtomic(balance.balance);
    return NextResponse.json({ address, network: NETWORK, availableAtomic: available.toString(), available: usdcDisplay(available), checkedAt: new Date().toISOString() }, { headers });
  } catch {
    return NextResponse.json({ error: "Gateway balance unavailable. Refresh manually; no zero balance is assumed." }, { status: 502, headers });
  } finally { clearTimeout(timer); }
}
