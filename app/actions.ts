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

"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE,
  constantTimeEqualStrings,
  createSessionToken,
  sessionCookieOptions,
  sha256Hex,
} from "@/lib/auth";

/**
 * Generic failure message. Both the "unknown email" and "wrong password" paths
 * return this same string so the response cannot be used to enumerate accounts.
 */
const INVALID_CREDENTIALS = "Invalid credentials";

export async function login(formData: FormData) {
  const email = formData.get("email");
  const password = formData.get("password");

  // Reject non-string form values instead of coercing them with `as string`,
  // which previously let a `File` part reach the comparison logic.
  if (typeof email !== "string" || typeof password !== "string") {
    return { error: INVALID_CREDENTIALS };
  }

  // Credentials come from the environment. The previous build shipped the
  // literals "admin@example.com" / "123456" in source, which meant every
  // deployment of this app had publicly known operator credentials.
  const expectedEmail = process.env.ADMIN_EMAIL;
  const expectedPasswordHash = process.env.ADMIN_PASSWORD_SHA256;

  if (!expectedEmail || !expectedPasswordHash) {
    // Fail closed: an unconfigured deployment authenticates nobody.
    console.error(
      "ADMIN_EMAIL and ADMIN_PASSWORD_SHA256 must both be set; refusing to authenticate.",
    );
    return { error: INVALID_CREDENTIALS };
  }

  // Compare digests in constant time so response timing does not leak the
  // credential prefix.
  const emailMatches = constantTimeEqualStrings(
    await sha256Hex(email.trim().toLowerCase()),
    await sha256Hex(expectedEmail.trim().toLowerCase()),
  );
  const passwordMatches = constantTimeEqualStrings(
    await sha256Hex(password),
    expectedPasswordHash.trim().toLowerCase(),
  );

  if (!emailMatches || !passwordMatches) {
    return { error: INVALID_CREDENTIALS };
  }

  let token: string;
  try {
    // Signed, expiring token — not the forgeable constant "authenticated".
    token = await createSessionToken(expectedEmail);
  } catch (error) {
    console.error(
      "Unable to issue session token:",
      error instanceof Error ? error.message : String(error),
    );
    return { error: "Server is not configured for sign-in." };
  }

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, sessionCookieOptions());

  redirect("/dashboard");
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  redirect("/");
}
