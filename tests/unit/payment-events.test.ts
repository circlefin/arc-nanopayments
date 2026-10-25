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

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PaymentEvent } from "@/hooks/use-transactions";

const harness = vi.hoisted(() => ({ states: [] as unknown[], index: 0, effects: [] as (() => void | (() => void))[], callbacks: {} as Record<string, (value: unknown) => void>, from: vi.fn(), remove: vi.fn() }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = harness.index++;
    harness.states[index] = initial;
    return [initial, (next: unknown) => { harness.states[index] = typeof next === "function" ? next(harness.states[index]) : next; }];
  },
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => void | (() => void)) => { harness.effects.push(effect); },
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({
  from: harness.from, removeChannel: harness.remove,
  channel: () => {
    const channel = {
      on: (_: string, filter: { event: string }, callback: (value: unknown) => void) => { harness.callbacks[filter.event] = callback; return channel; },
      subscribe: (callback: (value: unknown) => void) => { harness.callbacks.subscribe = callback; return channel; },
    };
    return channel;
  },
}) }));
import { usePaymentEvents } from "@/hooks/use-transactions";

const row = (id = "first", observed = false): PaymentEvent => ({
  id, created_at: "2026-10-24T00:00:00Z", endpoint: "/api/premium/compute", payer: "synthetic",
  amount_usdc: "0.0003", network: "eip155:5042002", gateway_tx: null,
  raw: { requirements: { amount: "300" }, other: "retained", ...(observed ? { resourceOutcome: { kind: "response", httpStatus: 200 } } : {}) },
});
const rows = () => harness.states[0] as PaymentEvent[];
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let resolve!: (result: { data: PaymentEvent[]; error: null }) => void;
beforeEach(() => {
  harness.states = []; harness.index = 0; harness.effects = []; harness.callbacks = {};
  const pending = new Promise<{ data: PaymentEvent[]; error: null }>(done => { resolve = done; });
  harness.from.mockReset().mockReturnValue({ select: () => ({ order: () => pending }) });
  usePaymentEvents(); harness.effects.forEach(effect => effect());
  harness.callbacks.subscribe("SUBSCRIBED");
});
afterEach(() => vi.restoreAllMocks());

it.each([true, false])("retains an absent-id terminal UPDATE before a stale snapshot (row included: %s)", async included => {
  harness.callbacks.UPDATE({ new: row("first", true) });
  resolve({ data: included ? [row()] : [], error: null });
  await tick();
  expect(rows()).toHaveLength(1);
  expect(rows()[0].raw?.resourceOutcome).toEqual({ kind: "response", httpStatus: 200 });
  harness.callbacks.INSERT({ new: row() });
  expect(rows()).toHaveLength(1);
  expect(rows()[0].raw?.resourceOutcome).toEqual({ kind: "response", httpStatus: 200 });
  expect(rows()[0].raw?.other).toBe("retained");
});

it("retains a loaded terminal outcome across reconnect queries and UPDATEs with unknown metadata", async () => {
  resolve({ data: [row()], error: null }); await tick();
  harness.callbacks.UPDATE({ new: row("first", true) });
  harness.callbacks.UPDATE({ new: row() });
  harness.from.mockReturnValue({ select: () => ({ order: async () => ({ data: [row()], error: null }) }) });
  harness.callbacks.subscribe("SUBSCRIBED"); await tick();
  expect(rows()[0].raw?.resourceOutcome).toEqual({ kind: "response", httpStatus: 200 });
});

it("keeps independent event outcomes and preserves normal INSERT/DELETE behavior", async () => {
  harness.callbacks.UPDATE({ new: row("first", true) });
  harness.callbacks.INSERT({ new: row("second") });
  resolve({ data: [row("first"), row("second")], error: null }); await tick();
  expect(rows()).toHaveLength(2);
  expect(rows().find(r => r.id === "first")?.raw?.resourceOutcome).toBeDefined();
  expect(rows().find(r => r.id === "second")?.raw?.resourceOutcome).toBeUndefined();
  harness.callbacks.DELETE({ old: { id: "first" } });
  expect(rows().map(r => r.id)).toEqual(["second"]);
});

it("does not upsert unrelated missing-id UPDATEs without valid observations", async () => {
  harness.callbacks.UPDATE({ new: row() });
  harness.callbacks.UPDATE({ new: { ...row(), raw: { resourceOutcome: { kind: "response", httpStatus: "200" } } } });
  expect(rows()).toEqual([]);
  resolve({ data: [], error: null }); await tick();
  expect(rows()).toEqual([]);
});
