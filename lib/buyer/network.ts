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

import { formatUnits, isAddress, parseUnits } from "viem";
import { arcTestnet } from "viem/chains";

export const NETWORK = "eip155:5042002";
export const USDC = "0x3600000000000000000000000000000000000000";
export const GATEWAY = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
export const DOMAIN = 26;
export const chain = {
  ...arcTestnet,
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" } },
};

export function usdcAtomic(value: unknown, positive = false): bigint {
  if (typeof value !== "string" || value.length > 80 || !/^\d+(?:\.\d{1,6})?$/.test(value)) {
    throw new Error("Enter USDC with at most six decimal places.");
  }
  const amount = parseUnits(value, 6);
  if (positive && amount === BigInt(0)) throw new Error("Enter an amount greater than zero.");
  return amount;
}

export const usdcDisplay = (amount: bigint) => formatUnits(amount, 6);
export const sameAddress = (a: unknown, b: string) =>
  typeof a === "string" && isAddress(a, { strict: false }) && a.toLowerCase() === b.toLowerCase();

// Only this public value crosses the server/client boundary. No environment object.
export function publicBuyerConfig(seller: string | undefined) {
  return { sellerAddress: seller && isAddress(seller, { strict: false }) && !/^0x0{40}$/i.test(seller)
    ? seller as `0x${string}` : null };
}
export type BuyerConfig = ReturnType<typeof publicBuyerConfig>;
