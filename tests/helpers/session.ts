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

import { vi } from "vitest";
import { createSessionToken, SESSION_COOKIE } from "@/lib/session";

export const TEST_SESSION_SECRET = "a-secret-that-is-long-enough";

/** A `next/headers` cookie store that either holds a valid session or nothing. */
export async function cookieStoreFor(signedIn: boolean) {
  const token = signedIn ? await createSessionToken(TEST_SESSION_SECRET) : undefined;
  return {
    get: vi.fn((name: string) =>
      name === SESSION_COOKIE && token ? { name, value: token } : undefined,
    ),
    set: vi.fn(),
    delete: vi.fn(),
  };
}
