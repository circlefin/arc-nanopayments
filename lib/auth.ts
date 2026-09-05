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

/**
 * Session issuing and verification for the operator dashboard.
 *
 * Tokens issued here are HMAC-SHA256 signed over a JSON payload and carry an
 * absolute expiry. Verification is constant-time and fails closed: a missing or
 * weak `SESSION_SECRET` makes verification impossible rather than permissive.
 *
 * Implemented on Web Crypto (`crypto.subtle`) so the same code runs in the Edge
 * middleware runtime and in Node.js route handlers.
 */

export const SESSION_COOKIE = "session";

/** Session lifetime. Kept short because this session authorizes fund movement. */
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours

/** Minimum entropy we are willing to accept for the signing secret. */
const MIN_SECRET_LENGTH = 32;

/** Exactly 64 hex characters (32 bytes) for a standard SHA-256 digest string. */
const SHA256_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

export interface SessionPayload {
  /** Subject — the authenticated operator identity. */
  sub: string;
  /** Issued-at, seconds since the Unix epoch. */
  iat: number;
  /** Absolute expiry, seconds since the Unix epoch. */
  exp: number;
}

const textEncoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Resolves the signing secret, or `null` when it is absent or too weak.
 */
function getSecret(): string | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return secret;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function sign(secret: string, data: string): Promise<Uint8Array> {
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(data),
  );
  return new Uint8Array(signature);
}

/**
 * Value-independent comparison of two fixed-length byte arrays.
 * Fails closed if length invariants are violated.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Constant-time comparison of two hex-encoded SHA-256 digest strings.
 *
 * Mitigates timing side-channels caused by length mismatches or early short-circuiting:
 * verifies both inputs match the strict 64-hex shape, and executes a dummy constant-time
 * pass if either argument is malformed before returning false.
 */
export function constantTimeEqualStrings(a: string, b: string): boolean {
  const validA = typeof a === "string" && SHA256_HEX_PATTERN.test(a);
  const validB = typeof b === "string" && SHA256_HEX_PATTERN.test(b);

  if (!validA || !validB) {
    // Perform a dummy constant-time pass against a fixed-size buffer to prevent timing leakage
    const dummyA = new Uint8Array(32);
    const dummyB = new Uint8Array(32);
    timingSafeEqual(dummyA, dummyB);
    return false;
  }

  return timingSafeEqual(
    textEncoder.encode(a.toLowerCase()),
    textEncoder.encode(b.toLowerCase()),
  );
}

/** Hex-encoded SHA-256 digest, used to compare credentials without storing them in cleartext. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Issues a signed session token for `subject`.
 *
 * @throws if `SESSION_SECRET` is unset or shorter than {@link MIN_SECRET_LENGTH}.
 */
export async function createSessionToken(subject: string): Promise<string> {
  const secret = getSecret();
  if (!secret) {
    throw new Error(
      `SESSION_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters before sessions can be issued.`,
    );
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: subject,
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
  };

  const encodedPayload = base64UrlEncode(
    textEncoder.encode(JSON.stringify(payload)),
  );
  const signature = await sign(secret, encodedPayload);
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

/**
 * Verifies a session token.
 *
 * @returns the payload on success, or `null` for any malformed, unsigned,
 *          tampered, or expired token. Never throws on attacker-controlled input.
 */
export async function verifySessionToken(
  token: string | undefined | null,
): Promise<SessionPayload | null> {
  const secret = getSecret();
  if (!secret || !token) return null;

  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;

  const encodedPayload = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);

  let expected: Uint8Array;
  let received: Uint8Array;
  try {
    expected = await sign(secret, encodedPayload);
    received = base64UrlDecode(providedSignature);
  } catch {
    return null;
  }

  if (!timingSafeEqual(expected, received)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
  } catch {
    return null;
  }

  if (typeof payload?.sub !== "string" || typeof payload?.exp !== "number") {
    return null;
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;

  return payload;
}

/** Cookie attributes shared by the login and logout paths. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}
