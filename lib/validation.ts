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

const USDC_AMOUNT = /^(?:\d+|\d+\.\d{1,6}|\.\d{1,6})$/;

/**
 * Parses a user-supplied USDC amount: a plain positive decimal with at most 6
 * decimal places. Rejects exponents, signs, NaN/Infinity and zero. Returns the
 * normalized string (".5" -> "0.5") and its exact 6-decimal base units.
 */
export function parseUsdcAmount(
  input: unknown,
): { value: string; micro: bigint } | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!USDC_AMOUNT.test(trimmed)) return null;

  const [whole = "0", fraction = ""] = trimmed.split(".");
  const value = `${whole === "" ? "0" : whole}${fraction ? `.${fraction}` : ""}`;
  const micro =
    BigInt(whole === "" ? "0" : whole) * BigInt(1_000_000) +
    BigInt(fraction.padEnd(6, "0") || "0");

  return micro > BigInt(0) ? { value, micro } : null;
}
