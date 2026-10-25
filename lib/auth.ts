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

import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, getSessionSecret, verifySessionToken } from "@/lib/session";

const DEFAULT_ADMIN_EMAIL = "admin@example.com";
const DEFAULT_ADMIN_PASSWORD = "123456";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time comparison, so response timing does not reveal how much matched. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** Demo credentials for the seller dashboard; override with ADMIN_EMAIL / ADMIN_PASSWORD. */
export function credentialsMatch(email: string, password: string): boolean {
  const expectedEmail = process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;
  const expectedPassword = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
  // Evaluate both so a wrong email and a wrong password take the same time.
  const emailOk = safeEqual(email, expectedEmail);
  const passwordOk = safeEqual(password, expectedPassword);
  return emailOk && passwordOk;
}

export async function hasValidSession(): Promise<boolean> {
  const cookieStore = await cookies();
  return verifySessionToken(
    cookieStore.get(SESSION_COOKIE)?.value,
    getSessionSecret(),
  );
}

/**
 * Guard for route handlers that act with the seller's funds or secrets. The proxy
 * also blocks these paths, but a handler must not rely on the proxy alone.
 * Returns a 401 response to return early with, or null when the caller is signed in.
 */
export async function requireSession(): Promise<NextResponse | null> {
  if (await hasValidSession()) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
