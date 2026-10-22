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

import { vi } from "vitest";
import { chain, GATEWAY, NETWORK, USDC } from "@/lib/buyer/network";
import type { InjectedProvider, WalletContext } from "@/lib/buyer/wallet";
import { resources } from "@/lib/buyer/resources";

export const BUYER = "0x1212121212121212121212121212121212121212";
export const SELLER = "0x3434343434343434343434343434343434343434";
export const HASH = `0x${"ab".repeat(32)}` as const;
export const REFERENCE = "01234567-1234-5678-9012-123456789abc";
export function challenge(): { x402Version: number; resource: { url: string; description: string; mimeType: string }; accepts: { scheme: string; network: string; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number; extra: { name: string; version: string; verifyingContract: string } }[] } {
  return { x402Version: 2, resource: { url: resources[0].path, description: "Quote ☀", mimeType: "application/json" }, accepts: [{
    scheme: "exact", network: NETWORK, asset: USDC, amount: "1000", payTo: SELLER, maxTimeoutSeconds: 345600,
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY },
  }] };
}
export const ack = () => ({ success: true, transaction: REFERENCE, network: NETWORK, payer: BUYER });

export function fakeWallet() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [BUYER];
    if (method === "eth_chainId") return `0x${chain.id.toString(16)}`;
    if (method === "eth_getCode") return "0x";
    if (method === "eth_signTypedData_v4") return `0x${"11".repeat(65)}`;
    throw new Error(`Unexpected mocked wallet method: ${method}`);
  });
  const provider: InjectedProvider = {
    request: request as InjectedProvider["request"],
    on: (event, listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    removeListener: (event, listener) => { listeners.get(event)?.delete(listener); },
  };
  const context: WalletContext = { provider, address: BUYER, generation: 0 };
  return { provider, request, context, listeners, emit: (event: string, value?: unknown) => listeners.get(event)?.forEach(listener => listener(value)) };
}
