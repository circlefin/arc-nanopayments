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

import type { PaymentRequirements } from "@x402/core/types";
import { createWalletClient, custom } from "viem";
import { chain, GATEWAY, NETWORK, sameAddress, USDC, usdcAtomic } from "./network";
import { boundedText, decodeHeader, encodeHeader, object } from "./http";
import type { Resource } from "./resources";
import { assertWallet, readProvider, type WalletContext } from "./wallet";

export interface Quote {
  resource: Resource;
  body?: string;
  requirements: PaymentRequirements;
  description: { url: string; description: string; mimeType: string };
  createdAt: number;
}
export interface PurchaseResult {
  status: number | null;
  payment: "unpaywalled" | "acknowledged" | "unknown";
  reference?: string;
  text: string;
  note?: string;
}

export function validateChallenge(header: string | null, resource: Resource, seller: string): Pick<Quote, "requirements" | "description"> {
  const data = decodeHeader(header);
  if (!object(data) || data.x402Version !== 2 || !Array.isArray(data.accepts) || data.accepts.length > 20 ||
      !object(data.resource) || data.resource.url !== resource.path ||
      typeof data.resource.description !== "string" || data.resource.description.length > 1000 ||
      data.resource.mimeType !== "application/json") throw new Error("Unsupported resource challenge.");
  const amount = usdcAtomic(resource.price, true).toString();
  const accepted = data.accepts.find((item: unknown) => object(item) &&
    item.scheme === "exact" && item.network === NETWORK && sameAddress(item.asset, USDC) &&
    sameAddress(item.payTo, seller) && item.amount === amount &&
    typeof item.maxTimeoutSeconds === "number" && Number.isSafeInteger(item.maxTimeoutSeconds) &&
    item.maxTimeoutSeconds > 0 && item.maxTimeoutSeconds <= 604900 && object(item.extra) &&
    item.extra.name === "GatewayWalletBatched" && item.extra.version === "1" &&
    sameAddress(item.extra.verifyingContract, GATEWAY));
  if (!accepted) throw new Error("Price, recipient or payment network does not match this sample. Get a new price after checking seller configuration.");
  // Reconstruct the accepted option from validated values; discard extra fields.
  return {
    requirements: { scheme: "exact", network: NETWORK, asset: USDC, amount, payTo: seller,
      maxTimeoutSeconds: accepted.maxTimeoutSeconds, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY } },
    description: { url: resource.path, description: data.resource.description, mimeType: "application/json" },
  };
}

export function acknowledgement(response: Response, payer: string): string | undefined {
  try {
    const value = decodeHeader(response.headers.get("PAYMENT-RESPONSE"));
    if (object(value) && value.success === true && value.network === NETWORK && sameAddress(value.payer, payer) &&
      typeof value.transaction === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.transaction)) {
      return value.transaction;
    }
  } catch { /* Malformed/missing acknowledgement cannot establish acceptance. */ }
}

export async function getPrice(resource: Resource, body: string | undefined, seller: string, signal: AbortSignal): Promise<Quote | PurchaseResult> {
  const response = await fetch(resource.path, {
    method: resource.method, body, signal, credentials: "omit", cache: "no-store", redirect: "error",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  });
  if (response.status === 402) {
    // Cancel an unused body; the price comes from the bounded header.
    void response.body?.cancel().catch(() => {});
    return { resource, body, ...validateChallenge(response.headers.get("PAYMENT-REQUIRED"), resource, seller), createdAt: Date.now() };
  }
  if (!response.ok) throw new Error(`Price request failed (HTTP ${response.status}).`);
  return { status: response.status, payment: "unpaywalled", text: await boundedText(response) };
}

export async function signQuote(quote: Quote, context: WalletContext, current: () => boolean) {
  if (Date.now() - quote.createdAt > 60000) throw new Error("Price is older than 60 seconds. Get price again.");
  await assertWallet(context, current);
  const code = await readProvider(context.provider, current).request({ method: "eth_getCode", params: [context.address, "latest"] });
  if (code && code !== "0x") throw new Error("This playground supports ordinary EOA wallets only.");
  await assertWallet(context, current);
  const { BatchEvmScheme } = await import("@circle-fin/x402-batching/client");
  const wallet = createWalletClient({ account: context.address, chain, transport: custom(context.provider, { retryCount: 0 }) });
  const scheme = new BatchEvmScheme({ address: context.address, signTypedData: async parameters => {
    await assertWallet(context, current);
    return wallet.signTypedData({ ...parameters, account: context.address });
  } });
  const partial = await scheme.createPaymentPayload(2, quote.requirements);
  await assertWallet(context, current);
  return encodeHeader({ ...partial, resource: quote.description, accepted: quote.requirements });
}

export async function submitPurchase(quote: Quote, signature: string, payer: string, signal: AbortSignal): Promise<PurchaseResult> {
  let response: Response | undefined;
  let reference: string | undefined;
  try {
    response = await fetch(quote.resource.path, {
      method: quote.resource.method, body: quote.body, signal,
      credentials: "omit", cache: "no-store", redirect: "error",
      headers: { "PAYMENT-SIGNATURE": signature, ...(quote.body === undefined ? {} : { "Content-Type": "application/json" }) },
    });
    reference = acknowledgement(response, payer);
    const text = await boundedText(response);
    return { status: response.status, payment: reference ? "acknowledged" : "unknown", reference, text,
      note: response.ok ? undefined : "Resource request failed. A failure does not establish that no payment was accepted." };
  } catch {
    return { status: response?.status ?? null, payment: reference ? "acknowledged" : "unknown", reference, text: "",
      note: reference ? "Payment acknowledged; resource response unavailable." : "Request interrupted. Payment outcome is unknown. Do not retry blindly." };
  }
}
