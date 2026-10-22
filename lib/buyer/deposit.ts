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

import {
  createPublicClient, createWalletClient, custom, encodeFunctionData, erc20Abi,
  type Hash, type TransactionReceipt,
} from "viem";
import { chain, GATEWAY, sameAddress, USDC } from "./network";
import { assertWallet, chainNumber, readProvider, type WalletContext } from "./wallet";

export const depositAbi = [{ type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [
  { name: "token", type: "address" }, { name: "value", type: "uint256" },
], outputs: [] }] as const;
export type DepositStep = "approval" | "deposit";
export interface DepositAttempt {
  context: WalletContext;
  step: DepositStep;
  amount: bigint;
  hash?: Hash;
  replacement?: "cancelled" | "replaced";
}
export type ReceiptOutcome = { kind: "confirmed" | "reverted" | "cancelled" | "replaced" | "paused" | "pending"; hash: Hash; replacement?: DepositAttempt["replacement"] };

export function stepCall(step: DepositStep, amount: bigint) {
  return step === "approval" ? {
    to: USDC, value: BigInt(0), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [GATEWAY, amount] }),
  } as const : {
    to: GATEWAY, value: BigInt(0), data: encodeFunctionData({ abi: depositAbi, functionName: "deposit", args: [USDC, amount] }),
  } as const;
}

export function sameIntent(attempt: DepositAttempt, transaction: { from: string; to: string | null; value: bigint; input: string }) {
  const call = stepCall(attempt.step, attempt.amount);
  return sameAddress(transaction.from, attempt.context.address) && sameAddress(transaction.to, call.to) &&
    transaction.value === call.value && transaction.input.toLowerCase() === call.data.toLowerCase();
}

export function replacementKind(attempt: DepositAttempt, reason: string, transaction: Parameters<typeof sameIntent>[1]) {
  if (reason === "cancelled") return "cancelled" as const;
  if (reason !== "repriced" || !sameIntent(attempt, transaction)) return "replaced" as const;
}

export function publicWallet(context: WalletContext, current: () => boolean = () => true) {
  return createPublicClient({ chain, transport: custom(readProvider(context.provider, current), { retryCount: 0 }) });
}

export async function allowance(context: WalletContext, current: () => boolean = () => true) {
  return publicWallet(context, current).readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [context.address, GATEWAY] });
}

// Exact conversion: Arc native USDC (18 decimals) and ERC20 USDC (6 decimals)
// spend the same funds. A deposit must leave room for its own transaction fee.
export function enoughForDeposit(balance: bigint, amount: bigint, fee: bigint) {
  return balance >= amount * BigInt(10) ** BigInt(12) + fee;
}

export async function prepareStep(context: WalletContext, step: DepositStep, amount: bigint, current: () => boolean) {
  await assertWallet(context, current);
  const client = publicWallet(context, current);
  const code = await client.getCode({ address: context.address });
  if (code && code !== "0x") throw new Error("This playground supports ordinary EOA wallets only.");
  const currentAllowance = await allowance(context, current);
  if (step === "approval" && currentAllowance >= amount) return null;
  if (step === "deposit" && currentAllowance < amount) throw new Error("Allowance is insufficient. Review approval again.");
  const call = stepCall(step, amount);
  // eth_estimateGas simulates the exact call; leave a conservative 20% gas margin.
  const gas = (await client.estimateGas({ account: context.address, ...call })) * BigInt(120) / BigInt(100);
  const fees = await client.estimateFeesPerGas();
  const fee = gas * fees.maxFeePerGas;
  const balance = await client.getBalance({ address: context.address });
  if (step === "deposit" ? !enoughForDeposit(balance, amount, fee) : balance < fee) {
    throw new Error("Insufficient wallet USDC for this step and its estimated gas. Leave USDC in the wallet for fees.");
  }
  await assertWallet(context, current);
  return { ...call, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, fee };
}

export async function sendStep(context: WalletContext, prepared: NonNullable<Awaited<ReturnType<typeof prepareStep>>>, current: () => boolean, onDispatch: () => void = () => {}) {
  await assertWallet(context, current);
  let dispatched = false;
  const reader = readProvider(context.provider, current);
  const wallet = createWalletClient({ account: context.address, chain, transport: custom({ request: request => {
    if (request.method !== "eth_sendTransaction" && request.method !== "wallet_sendTransaction") return reader.request(request);
    // viem can make an internal chain read and a namespace fallback. Enforce the
    // app's lifecycle and one-attempt contract at the actual provider boundary.
    if (dispatched) throw new Error("Transaction submission was already attempted. Inspect wallet activity; no automatic resubmission.");
    if (!current()) throw new Error("Wallet context changed. Transaction not submitted.");
    dispatched = true;
    onDispatch();
    return context.provider.request(request);
  } }, { retryCount: 0 }) });
  const { to, value, data, gas, maxFeePerGas, maxPriorityFeePerGas } = prepared;
  return wallet.sendTransaction({ to, value, data, gas, maxFeePerGas, maxPriorityFeePerGas, account: context.address });
}

export async function waitForStep(attempt: DepositAttempt, current: () => boolean): Promise<ReceiptOutcome> {
  const { context, hash } = attempt;
  if (!hash) throw new Error("No transaction hash available. Inspect wallet activity.");
  if (attempt.replacement) return { kind: attempt.replacement, hash, replacement: attempt.replacement };
  let replacement: "cancelled" | "replaced" | undefined;
  let lastHash = hash;
  let paused = false;
  let reading = true;
  const reader = readProvider(context.provider, () => reading && current());
  const check = async () => {
    if (!current()) { paused = true; throw new Error("Receipt reads paused."); }
    const network = await reader.request({ method: "eth_chainId" });
    if (!current() || chainNumber(network) !== chain.id) { paused = true; throw new Error("Receipt reads paused."); }
  };
  // A chain definition on a public client does not pin an injected provider.
  // Check before AND after every RPC; never apply a late wrong-context result.
  const client = createPublicClient({ chain, transport: custom({ request: async request => {
    await check();
    const response = await reader.request(request);
    await check();
    return response;
  } }, { retryCount: 0 }) });
  let receipt: TransactionReceipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout: 15000, pollingInterval: 1000, retryCount: 0,
      onReplaced: event => {
        lastHash = event.transaction.hash;
        replacement = replacementKind(attempt, event.reason, event.transaction);
      },
    });
    await check();
  } catch {
    // An observed cancellation/different replacement is historical evidence.
    // A subsequent pause must not turn its successful receipt into a deposit.
    if (replacement) return { kind: replacement, hash: lastHash, replacement };
    return { kind: paused || !current() ? "paused" : "pending", hash: lastHash };
  } finally {
    reading = false;
  }
  return replacement ? { kind: replacement, hash: receipt.transactionHash, replacement }
    : { kind: receipt.status === "success" ? "confirmed" : "reverted", hash: receipt.transactionHash };
}
