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
import type { InjectedProvider, WalletContext } from "@/lib/buyer/wallet";
import { chain } from "@/lib/buyer/network";
import { stepCall } from "@/lib/buyer/deposit";
import { BUYER, HASH } from "./buyer-fixtures";

export const REPLACEMENT_HASH = `0x${"cd".repeat(32)}` as const;
const BLOCK_HASH = `0x${"ef".repeat(32)}`;
export const CHAIN_HEX = `0x${chain.id.toString(16)}`;
export const FUNDING_AMOUNT = BigInt(100000);

export function rpcTransaction(hash = HASH, call = stepCall("deposit", FUNDING_AMOUNT)) {
  return { hash, blockHash: null, blockNumber: null, transactionIndex: null, from: BUYER, to: String(call.to),
    input: String(call.data), value: "0x0", nonce: "0x1", gas: "0x186a0", maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1",
    type: "0x2", chainId: CHAIN_HEX, r: "0x1", s: "0x1", v: "0x0" };
}
export function rpcReceipt(hash = HASH, status = "0x1") {
  return { transactionHash: hash, blockHash: BLOCK_HASH, blockNumber: "0x10", transactionIndex: "0x0",
    from: BUYER, to: stepCall("deposit", FUNDING_AMOUNT).to, cumulativeGasUsed: "0x5208", gasUsed: "0x5208",
    effectiveGasPrice: "0x1", contractAddress: null, logs: [], logsBloom: `0x${"0".repeat(512)}`, status, type: "0x2" };
}
export function rpcBlock(transactions: ReturnType<typeof rpcTransaction>[] = []) {
  return { number: "0x10", hash: BLOCK_HASH, parentHash: BLOCK_HASH, transactions, timestamp: "0x1", gasLimit: "0x100000",
    gasUsed: "0x5208", baseFeePerGas: "0x1", difficulty: "0x0", totalDifficulty: "0x0", size: "0x1",
    nonce: "0x0000000000000000", miner: BUYER, extraData: "0x", logsBloom: `0x${"0".repeat(512)}`,
    sha3Uncles: BLOCK_HASH, receiptsRoot: BLOCK_HASH, stateRoot: BLOCK_HASH, transactionsRoot: BLOCK_HASH, uncles: [] };
}

// Stateful EIP-1193 boundary, not a mock of any application helper or viem action.
// Unexpected RPCs fail locally; no provider request can leave this process.
export function buyerProvider() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  const state = { account: BUYER as string, chain: CHAIN_HEX, allowance: FUNDING_AMOUNT, balance: BigInt(10) ** BigInt(18) };
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    if (handlers.has(method)) return handlers.get(method)!(params);
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [state.account];
    if (method === "eth_chainId") return state.chain;
    if (method === "eth_getCode") return "0x";
    if (method === "eth_call") return `0x${state.allowance.toString(16).padStart(64, "0")}`;
    if (method === "eth_getBalance") return `0x${state.balance.toString(16)}`;
    if (method === "eth_estimateGas") return "0x186a0";
    if (method === "eth_maxPriorityFeePerGas" || method === "eth_gasPrice") return "0x1";
    if (method === "eth_getBlockByNumber") return rpcBlock();
    if (method === "eth_blockNumber") return "0x10";
    if (method === "eth_getTransactionReceipt") return rpcReceipt();
    if (method === "eth_getTransactionByHash") return rpcTransaction();
    if (method === "eth_sendTransaction" || method === "wallet_sendTransaction") return HASH;
    throw new Error(`Unexpected inert provider method: ${method}`);
  });
  const emit = (event: string, value?: unknown) => {
    if (event === "accountsChanged" && Array.isArray(value)) state.account = value[0];
    if (event === "chainChanged" && typeof value === "string") state.chain = value;
    listeners.get(event)?.forEach(listener => listener(value));
  };
  const provider: InjectedProvider = {
    request: request as InjectedProvider["request"],
    on(event, listener) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(listener); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  const context: WalletContext = { provider, address: BUYER, generation: 0 };
  return { provider, context, state, handlers, request, emit };
}
