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

/** Bounded preparation only; the paid computation must run after acceptance. */
export class ComputeInputError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const MAX_BYTES = 16 * 1024;
const READ_TIMEOUT_MS = 5000;

export async function readComputeText(request: Request): Promise<string> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ComputeInputError(415, "Content-Type must be application/json.");
  }
  if (Number(request.headers.get("content-length")) > MAX_BYTES) {
    throw new ComputeInputError(413, "Request body exceeds 16 KiB.");
  }
  if (!request.body) throw new ComputeInputError(400, "A JSON text field is required.");
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expires = performance.now() + READ_TIMEOUT_MS;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ComputeInputError(408, "Request body timed out.")), READ_TIMEOUT_MS);
  });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      if (performance.now() >= expires) {
        throw new ComputeInputError(408, "Request body timed out.");
      }
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new ComputeInputError(413, "Request body exceeds 16 KiB.");
      if (value.byteLength) chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof body !== "object" || body === null || Array.isArray(body) || !Object.hasOwn(body, "text") ||
      typeof (body as Record<string, unknown>).text !== "string") {
      throw new ComputeInputError(400, "text must be a string of 1–2,000 UTF-16 code units.");
    }
    const text = (body as { text: string }).text;
    if (text.length < 1 || text.length > 2000) {
      throw new ComputeInputError(400, "text must be a string of 1–2,000 UTF-16 code units.");
    }
    return text;
  } catch (error) {
    if (error instanceof ComputeInputError) throw error;
    throw new ComputeInputError(400, "Invalid JSON request body.");
  } finally {
    clearTimeout(timer);
    // Cancellation itself can hang. It must never delay a rejection/deadline.
    void reader.cancel().catch(() => {});
  }
}
