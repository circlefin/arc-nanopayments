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

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !publishableKey || !secretKey) {
  throw new Error(
    "Integration tests need the local Supabase stack. Run `npm run db:start` and make sure .env.local has NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY (see `npm run db:status`).",
  );
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(url, secretKey, options);
const anon = createClient(url, publishableKey, options);

const marker = `it-${randomUUID()}`;

afterAll(async () => {
  await service.from("payment_events").delete().eq("endpoint", marker);
  await service.from("withdrawals").delete().eq("destination_chain", marker);
});

async function seedPayment() {
  const { data, error } = await service
    .from("payment_events")
    .insert({ endpoint: marker, payer: "0xpayer", amount_usdc: "0.03", network: "eip155:5042002" })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as { id: string };
}

async function seedWithdrawal() {
  const { data, error } = await service
    .from("withdrawals")
    .insert({ amount_usdc: "1", destination_chain: marker, destination_address: "0xdest" })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as { id: string };
}

describe("payment_events", () => {
  it("is readable with the publishable key (the dashboard's realtime feed relies on it)", async () => {
    const { id } = await seedPayment();
    const { data, error } = await anon.from("payment_events").select("id").eq("id", id);
    expect(error).toBeNull();
    expect(data).toEqual([{ id }]);
  });

  it("cannot be written, edited or deleted with the publishable key", async () => {
    const { id } = await seedPayment();

    const insert = await anon
      .from("payment_events")
      .insert({ endpoint: marker, payer: "0xattacker", amount_usdc: "1000", network: "x" });
    expect(insert.error).not.toBeNull();

    const update = await anon.from("payment_events").update({ amount_usdc: "0" }).eq("id", id).select();
    expect(update.data ?? []).toEqual([]);

    const remove = await anon.from("payment_events").delete().eq("id", id).select();
    expect(remove.data ?? []).toEqual([]);

    const { data } = await service.from("payment_events").select("amount_usdc").eq("id", id).single();
    expect(data!.amount_usdc).toBe("0.03");
  });
});

describe("withdrawals", () => {
  it("is readable but not writable with the publishable key", async () => {
    const { id } = await seedWithdrawal();

    const read = await anon.from("withdrawals").select("id").eq("id", id);
    expect(read.data).toEqual([{ id }]);

    const insert = await anon
      .from("withdrawals")
      .insert({ amount_usdc: "1", destination_chain: marker, destination_address: "0xattacker" });
    expect(insert.error).not.toBeNull();

    const update = await anon.from("withdrawals").update({ status: "confirmed" }).eq("id", id).select();
    expect(update.data ?? []).toEqual([]);
    const { data } = await service.from("withdrawals").select("status").eq("id", id).single();
    expect(data!.status).toBe("submitted");
  });

  it("only allows the documented statuses", async () => {
    const { error } = await service
      .from("withdrawals")
      .insert({ amount_usdc: "1", destination_chain: marker, destination_address: "0xd", status: "hacked" });
    expect(error?.code).toBe("23514"); // check_violation
  });
});

describe("GraphQL endpoint", () => {
  it("is gone, so tables are not introspectable through it", async () => {
    const response = await fetch(`${url}/graphql/v1`, {
      method: "POST",
      headers: { apikey: publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __schema { types { name } } }" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain("payment_events");
  });
});
