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

export type ResourceOutcome =
  | { kind: "response"; httpStatus: number }
  | { kind: "handler_error"; httpStatus: 500 };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** raw is legacy/public JSON, not a guarantee of a valid observation. */
export function readResourceOutcome(raw: unknown): ResourceOutcome | undefined {
  if (!object(raw) || !Object.hasOwn(raw, "resourceOutcome") || !object(raw.resourceOutcome)) return;
  const { kind, httpStatus } = raw.resourceOutcome;
  if (typeof httpStatus !== "number" || !Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus > 599) return;
  if (kind === "response") return { kind, httpStatus };
  if (kind === "handler_error" && httpStatus === 500) return { kind, httpStatus };
}

/** A stale snapshot must not erase an already-observed terminal result. */
export function retainResourceOutcome<T extends { raw: Record<string, unknown> | null }>(previous: T | undefined, incoming: T): T {
  const known = readResourceOutcome(previous?.raw);
  if (!known || readResourceOutcome(incoming.raw)) return incoming;
  return { ...incoming, raw: { ...previous?.raw, ...incoming.raw, resourceOutcome: known } };
}

export function resourceOutcomeLabel(raw: unknown): string {
  const outcome = readResourceOutcome(raw);
  if (!outcome) return "Not observed";
  if (outcome.kind === "handler_error") return "Handler failed · 500";
  return `${outcome.httpStatus >= 400 ? "Error response" : "Response produced"} · ${outcome.httpStatus}`;
}
