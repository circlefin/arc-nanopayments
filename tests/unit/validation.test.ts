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

import { describe, expect, it } from "vitest";
import { parseUsdcAmount } from "@/lib/validation";

describe("parseUsdcAmount", () => {
  it.each([
    ["1", "1", BigInt("1000000")],
    ["0.5", "0.5", BigInt("500000")],
    [".5", "0.5", BigInt("500000")],
    ["10.123456", "10.123456", BigInt("10123456")],
    ["  2.5 ", "2.5", BigInt("2500000")],
    ["0.000001", "0.000001", BigInt("1")],
    ["9007199254740993", "9007199254740993", BigInt("9007199254740993000000")],
  ])("accepts %j", (input, value, micro) => {
    expect(parseUsdcAmount(input)).toEqual({ value, micro });
  });

  it.each([
    "0",
    "0.0",
    "0.000000",
    "-1",
    "+1",
    "1e3",
    "1.",
    "abc",
    "",
    " ",
    "1.1234567",
    "1,5",
    "NaN",
    "Infinity",
    "0x10",
  ])("rejects %j", (input) => {
    expect(parseUsdcAmount(input)).toBeNull();
  });

  it("rejects non-strings", () => {
    for (const input of [1, 0.5, null, undefined, {}, ["1"], true]) {
      expect(parseUsdcAmount(input)).toBeNull();
    }
  });
});
