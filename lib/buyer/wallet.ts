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

import { isAddress, type Address, type EIP1193Provider, type EIP1193Parameters, type EIP1474Methods } from "viem";
import { chain, sameAddress } from "./network";

export interface InjectedProvider extends EIP1193Provider {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}
export interface WalletChoice { id: string; name: string; provider: InjectedProvider }
export interface WalletContext { provider: InjectedProvider; address: Address; generation: number }

export function isProvider(value: unknown): value is InjectedProvider {
  return typeof value === "object" && value !== null && "request" in value && typeof value.request === "function" &&
    "on" in value && typeof value.on === "function" && "removeListener" in value && typeof value.removeListener === "function";
}

export function firstAddress(value: unknown): Address | null {
  return Array.isArray(value) && typeof value[0] === "string" && isAddress(value[0], { strict: false }) ? value[0] as Address : null;
}

export function chainNumber(value: unknown): number | null {
  return typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

export const WALLET_READ_TIMEOUT_MS = 5000;

// Only read operations use this deadline. A late provider result is discarded;
// this does not claim to cancel a wallet prompt or a broadcast transaction.
export function readWithDeadline<T>(read: () => Promise<T>, current: () => boolean, timeout = WALLET_READ_TIMEOUT_MS): Promise<T> {
  if (!current()) return Promise.reject(new Error("Wallet context changed. Review again."));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(invalidation);
      complete();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("Wallet read timed out. Check your wallet and refresh manually."))), timeout);
    // App Disconnect changes the generation without an EIP-1193 event. Observe
    // that local invalidation too, without issuing any extra wallet/RPC calls.
    const invalidation = setInterval(() => {
      if (!current()) finish(() => reject(new Error("Wallet context changed. Review again.")));
    }, 100);
    Promise.resolve().then(() => {
      if (!current()) throw new Error("Wallet context changed. Review again.");
      return read();
    }).then(value => finish(() => current() ? resolve(value) : reject(new Error("Wallet context changed. Review again."))),
      error => finish(() => reject(error)));
  });
}

const READ_METHODS = new Set([
  "eth_accounts", "eth_chainId", "eth_getBalance", "eth_getCode", "eth_call",
  "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_blockNumber",
  "eth_getBlockByNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt",
]);

export function readProvider(provider: EIP1193Provider, current: () => boolean = () => true) {
  return { request: (request: EIP1193Parameters<EIP1474Methods>) => {
    if (!READ_METHODS.has(request.method)) throw new Error("Only read-only wallet requests may use a read deadline.");
    return readWithDeadline(() => provider.request(request), current);
  } };
}

export async function assertWallet(context: WalletContext, current: () => boolean) {
  if (!current()) throw new Error("Wallet context changed. Review again.");
  const reader = readProvider(context.provider, current);
  const accounts = await reader.request({ method: "eth_accounts" });
  const network = await reader.request({ method: "eth_chainId" });
  if (!current() || !sameAddress(firstAddress(accounts), context.address) || chainNumber(network) !== chain.id) {
    throw new Error("Select the original wallet account on Arc Testnet and review again.");
  }
}

export function userRejected(error: unknown): boolean {
  const seen = new Set<unknown>();
  let value = error;
  while (typeof value === "object" && value !== null && !seen.has(value)) {
    seen.add(value);
    if ("code" in value && value.code === 4001) return true;
    value = "cause" in value ? value.cause : null;
  }
  return false;
}

export async function switchToArc(provider: InjectedProvider, add = false) {
  if (add) {
    await provider.request({ method: "wallet_addEthereumChain", params: [{
      chainId: `0x${chain.id.toString(16)}`, chainName: "Arc Testnet",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: chain.rpcUrls.default.http, blockExplorerUrls: [chain.blockExplorers.default.url],
    }] });
  } else {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${chain.id.toString(16)}` }] });
  }
}
