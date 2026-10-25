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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy, config } from "@/proxy";
import { SESSION_COOKIE, createSessionToken } from "@/lib/session";

const SECRET = "a-secret-that-is-long-enough";
const BASE = "http://localhost:3000";

const request = (path: string, cookie?: string, method = "GET") =>
  new NextRequest(`${BASE}${path}`, {
    method,
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy", () => {
  it("runs on the seller APIs, not only the pages", () => {
    expect(config.matcher).toEqual(
      expect.arrayContaining(["/dashboard/:path*", "/api/gateway/:path*"]),
    );
  });

  it.each(["/api/gateway/withdraw", "/api/gateway/balance"])(
    "answers 401 to a signed-out request for %s",
    async (path) => {
      const response = await proxy(request(path, undefined, "POST"));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    },
  );

  it("does not accept the old forgeable cookie", async () => {
    const api = await proxy(request("/api/gateway/withdraw", "authenticated", "POST"));
    expect(api.status).toBe(401);

    const page = await proxy(request("/dashboard", "authenticated"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe(`${BASE}/`);
  });

  it("redirects signed-out visitors away from the dashboard", async () => {
    const response = await proxy(request("/dashboard"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${BASE}/`);
  });

  it("lets a valid session through to the API and the dashboard", async () => {
    const token = await createSessionToken(SECRET);
    for (const path of ["/api/gateway/withdraw", "/api/gateway/balance", "/dashboard"]) {
      const response = await proxy(request(path, token));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("sends a signed-in visitor from the sign-in page to the dashboard", async () => {
    const token = await createSessionToken(SECRET);
    const response = await proxy(request("/", token));
    expect(response.headers.get("location")).toBe(`${BASE}/dashboard`);
  });

  it("blocks everything when SESSION_SECRET is not configured", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    const token = await createSessionToken(SECRET);
    const response = await proxy(request("/api/gateway/balance", token));
    expect(response.status).toBe(401);
  });
});
