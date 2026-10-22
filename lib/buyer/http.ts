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

export const MAX_BODY = 64 * 1024;

// Bound bytes read, not just the rendered text. The caller's abort timer covers
// both response headers and this stream (including an unresponsive body).
export async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) throw new Error("Response exceeds the 64 KiB display limit.");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    // Do not await a remote stream's cancellation handshake.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeHeader(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
}

export function decodeHeader(value: string | null): unknown {
  if (!value || value.length > 16384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Missing or invalid payment header.");
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(atob(value), char => char.charCodeAt(0)),
  ));
}

export function message(error: unknown) {
  return error instanceof Error ? error.message : "The operation could not be completed.";
}
