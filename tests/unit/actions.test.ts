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

const cookieStore = vi.hoisted(() => ({ set: vi.fn(), delete: vi.fn(), get: vi.fn() }));
const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
);
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("next/navigation", () => ({ redirect }));

import { login, logout } from "@/app/actions";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

const SECRET = "a-secret-that-is-long-enough";

const form = (email: string, password: string) => {
  const data = new FormData();
  data.set("email", email);
  data.set("password", password);
  return data;
};

beforeEach(() => {
  cookieStore.set.mockReset();
  cookieStore.delete.mockReset();
  vi.stubEnv("SESSION_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("login", () => {
  it("rejects wrong credentials without setting a cookie", async () => {
    expect(await login(form("admin@example.com", "wrong"))).toEqual({
      error: "Invalid credentials",
    });
    expect(await login(form("someone@else.com", "123456"))).toEqual({
      error: "Invalid credentials",
    });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("issues a signed, httpOnly session cookie and redirects", async () => {
    await expect(login(form("admin@example.com", "123456"))).rejects.toThrow(
      "NEXT_REDIRECT:/dashboard",
    );

    const [name, value, options] = cookieStore.set.mock.calls[0];
    expect(name).toBe(SESSION_COOKIE);
    expect(value).not.toBe("authenticated");
    expect(await verifySessionToken(value, SECRET)).toBe(true);
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("honours ADMIN_EMAIL and ADMIN_PASSWORD overrides", async () => {
    vi.stubEnv("ADMIN_EMAIL", "boss@example.com");
    vi.stubEnv("ADMIN_PASSWORD", "correct horse battery");

    expect(await login(form("admin@example.com", "123456"))).toEqual({
      error: "Invalid credentials",
    });
    await expect(login(form("boss@example.com", "correct horse battery"))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
  });

  it("refuses to issue a session when SESSION_SECRET is missing", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    const result = await login(form("admin@example.com", "123456"));
    expect(result?.error).toMatch(/SESSION_SECRET/);
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("does not reveal the missing configuration to someone with bad credentials", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    expect(await login(form("admin@example.com", "nope"))).toEqual({
      error: "Invalid credentials",
    });
  });

  it("ignores non-string form fields", async () => {
    const data = new FormData();
    data.set("email", new Blob(["x"]), "x.txt");
    data.set("password", "123456");
    expect(await login(data)).toEqual({ error: "Invalid credentials" });
  });
});

describe("logout", () => {
  it("clears the session cookie and redirects home", async () => {
    await expect(logout()).rejects.toThrow("NEXT_REDIRECT:/");
    expect(cookieStore.delete).toHaveBeenCalledWith(SESSION_COOKIE);
  });
});
