/** Copyright 2026 Circle Internet Group, Inc. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_SESSION_SECRET, cookieStoreFor } from "../helpers/session";
import { queryBuilder } from "../helpers/supabase-mock";
import { EVENT_ID, PAYER, SELLER, TRANSFER_ID, paymentFixture, transferFixture } from "../helpers/settlement-fixtures";

const { cookies, createClient, from } = vi.hoisted(() => ({ cookies: vi.fn(), createClient: vi.fn(), from: vi.fn() }));
vi.mock("next/headers", () => ({ cookies }));
vi.mock("@supabase/supabase-js", () => ({ createClient }));
import { GET } from "@/app/api/gateway/payments/[id]/settlement/route";

const call = (id = EVENT_ID) => GET(new Request(`http://localhost/api/gateway/payments/${id}/settlement`), { params: Promise.resolve({ id }) });
let query: ReturnType<typeof queryBuilder>;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("SESSION_SECRET", TEST_SESSION_SECRET);
  vi.stubEnv("SELLER_ADDRESS", SELLER);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SECRET_KEY", "synthetic-server-key");
  vi.stubEnv("SELLER_PRIVATE_KEY", undefined);
  cookies.mockResolvedValue(await cookieStoreFor(true));
  query = queryBuilder({ data: paymentFixture() });
  from.mockImplementation(() => query);
  createClient.mockReturnValue({ from });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(transferFixture())));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("manual settlement route", () => {
  it("uses PR42's unchanged unauthorized response before any DB or Gateway access", async () => {
    cookies.mockResolvedValue(await cookieStoreFor(false));
    const result = await call();
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: "Unauthorized" });
    expect(createClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads the fresh local event and makes exactly one uncached fixed-host GET without a wallet key", async () => {
    const result = await call();
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(await result.json()).toMatchObject({ paymentEventId: EVENT_ID, transferId: TRANSFER_ID, status: "received", txHash: null });
    expect(createClient).toHaveBeenCalledWith("http://localhost:54321", "synthetic-server-key");
    expect(from).toHaveBeenCalledWith("payment_events");
    expect(query.select).toHaveBeenCalledWith("id,gateway_tx,network,payer,raw");
    expect(query.eq).toHaveBeenCalledWith("id", EVENT_ID);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`https://gateway-api-testnet.circle.com/v1/x402/transfers/${TRANSFER_ID}`,
      expect.objectContaining({ method: "GET", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal) }));
    expect(query.insert).not.toHaveBeenCalled();
    expect(query.update).not.toHaveBeenCalled();
    expect(query.delete).not.toHaveBeenCalled();
  });

  it("rejects an invalid event ID before creating a database client", async () => {
    expect((await call("not-a-uuid")).status).toBe(400);
    expect(createClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [null, 404], [{ ...paymentFixture(), gateway_tx: null }, 409],
    [{ ...paymentFixture(), raw: null }, 409], [{ ...paymentFixture(), payer: "unknown" }, 409],
    [{ ...paymentFixture(), raw: { requirements: { ...paymentFixture().raw.requirements, payTo: PAYER } } }, 404],
  ])("rejects missing or ineligible stored metadata without a lookup", async (data, status) => {
    query = queryBuilder({ data });
    expect((await call()).status).toBe(status);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["SELLER_ADDRESS", "SUPABASE_SECRET_KEY", "NEXT_PUBLIC_SUPABASE_URL"])("handles missing %s without a remote call", async name => {
    vi.stubEnv(name, "");
    expect((await call()).status).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sanitizes storage errors", async () => {
    query = queryBuilder({ error: { message: "private storage details" } });
    const result = await call();
    expect(result.status).toBe(500);
    expect(await result.text()).not.toContain("private storage");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500, 302])("maps upstream HTTP %i to a check error, never local session expiry", async status => {
    vi.mocked(fetch).mockResolvedValue(new Response("private upstream details", { status }));
    const result = await call();
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("private upstream");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps transfer-not-found separate from a failed payment", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));
    const result = await call();
    expect(result.status).toBe(404);
    expect(await result.json()).toMatchObject({ code: "transfer_not_found" });
  });

  it("handles redirect/network rejection without retrying or exposing details", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("private redirect/network details"));
    const result = await call();
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("private redirect");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["malformed", "mismatched"])("rejects a %s response", async kind => {
    vi.mocked(fetch).mockResolvedValue(kind === "malformed"
      ? new Response("{bad-json") : Response.json({ ...transferFixture(), id: EVENT_ID }));
    expect((await call()).status).toBe(502);
  });

  it.each(["headers", "body"])("times out while waiting for %s", async stage => {
    vi.useFakeTimers();
    const readingBody = vi.fn();
    vi.mocked(fetch).mockImplementation((_url, options) => {
      const abort = () => new Promise<never>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return stage === "headers" ? abort() : Promise.resolve({ ok: true, status: 200,
        json: () => { readingBody(); return abort(); } } as unknown as Response);
    });
    const pending = call();
    await vi.waitFor(() => expect(stage === "body" ? readingBody : fetch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).status).toBe(504);
  });
});
