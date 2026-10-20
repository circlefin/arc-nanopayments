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

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  getSessionSecret,
  verifySessionToken,
} from "@/lib/session";

const SECRET = "a-secret-that-is-long-enough";
const NOW = 1_800_000_000_000;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session tokens", () => {
  it("accepts a token it issued", async () => {
    const token = await createSessionToken(SECRET, NOW);
    expect(await verifySessionToken(token, SECRET, NOW + 1000)).toBe(true);
  });

  it("rejects the old forgeable cookie value and other junk", async () => {
    for (const forged of [
      "authenticated",
      "",
      "v1",
      "v1.123",
      "v1.9999999999999.",
      "v1.9999999999999.zz",
      "v2.9999999999999.abcd",
      "v1.9999999999999.abcd.extra",
    ]) {
      expect(await verifySessionToken(forged, SECRET, NOW)).toBe(false);
    }
    expect(await verifySessionToken(undefined, SECRET, NOW)).toBe(false);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken("another-secret-of-same-length", NOW);
    expect(await verifySessionToken(token, SECRET, NOW)).toBe(false);
  });

  it("rejects a token whose expiry was extended", async () => {
    const token = await createSessionToken(SECRET, NOW);
    const [version, expiry, signature] = token.split(".");
    const extended = `${version}.${Number(expiry) + 10 * 365 * 24 * 3600 * 1000}.${signature}`;
    expect(await verifySessionToken(extended, SECRET, NOW)).toBe(false);
  });

  it("rejects a token with a flipped signature bit", async () => {
    const token = await createSessionToken(SECRET, NOW);
    const last = token.slice(-1);
    const tampered = token.slice(0, -1) + (last === "0" ? "1" : "0");
    expect(await verifySessionToken(tampered, SECRET, NOW)).toBe(false);
  });

  it("expires after the session lifetime", async () => {
    const token = await createSessionToken(SECRET, NOW);
    const justBefore = NOW + SESSION_MAX_AGE_SECONDS * 1000 - 1;
    const atExpiry = NOW + SESSION_MAX_AGE_SECONDS * 1000;
    expect(await verifySessionToken(token, SECRET, justBefore)).toBe(true);
    expect(await verifySessionToken(token, SECRET, atExpiry)).toBe(false);
  });

  it("fails closed when there is no secret", async () => {
    const token = await createSessionToken(SECRET, NOW);
    expect(await verifySessionToken(token, undefined, NOW)).toBe(false);
    expect(await verifySessionToken(token, "", NOW)).toBe(false);
  });
});

describe("getSessionSecret", () => {
  it("returns a sufficiently long secret", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    expect(getSessionSecret()).toBe(SECRET);
  });

  it("refuses unset and too-short secrets", () => {
    vi.stubEnv("SESSION_SECRET", "");
    expect(getSessionSecret()).toBeUndefined();
    vi.stubEnv("SESSION_SECRET", "short");
    expect(getSessionSecret()).toBeUndefined();
  });
});
