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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn() }));
vi.mock("@circle-fin/x402-batching/server", () => ({
  BatchFacilitatorClient: function () { return facilitator; },
}));

const SELLER = `0x${"ab".repeat(20)}`;
const PAYER = `0x${"cd".repeat(20)}`;
const ID = "11111111-1111-4111-8111-111111111111";
const REFERENCE = "22222222-2222-4222-8222-222222222222";
const payment = Buffer.from(JSON.stringify({ x402Version: 2, payload: {} })).toString("base64");
type DbCall = { method: string; url: URL; body: Record<string, unknown>; signal?: AbortSignal | null };
let calls: DbCall[];
let respond: (call: DbCall) => Promise<Response>;
let withGateway: typeof import("@/lib/x402").withGateway;
let compute: typeof import("@/app/api/premium/compute/route").POST;

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});
const paid = () => new NextRequest("http://localhost/api/premium/test", { headers: { "payment-signature": payment } });
const receipt = (response: Response) => JSON.parse(Buffer.from(response.headers.get("PAYMENT-RESPONSE")!, "base64").toString());
const handler = () => vi.fn(async () => NextResponse.json({ resource: "ok" }));

beforeEach(async () => {
  vi.resetModules();
  calls = [];
  respond = async call => call.method === "POST" ? json({ id: ID }, 201) : new Response(null, { status: 204 });
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://lifecycle.invalid");
  vi.stubEnv("SUPABASE_SECRET_KEY", "synthetic-test-key");
  vi.stubEnv("SELLER_ADDRESS", SELLER);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== "https://lifecycle.invalid" || url.pathname !== "/rest/v1/payment_events") {
      throw new Error(`Unexpected transport: ${url.origin}${url.pathname}`);
    }
    const call = { method: init?.method ?? "GET", url, body: JSON.parse(String(init?.body ?? "{}")), signal: init?.signal };
    calls.push(call);
    return respond(call);
  }));
  facilitator.verify.mockReset().mockResolvedValue({ isValid: true, payer: PAYER });
  facilitator.settle.mockReset().mockResolvedValue({ success: true, payer: PAYER, transaction: REFERENCE });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  ({ withGateway } = await import("@/lib/x402"));
  ({ POST: compute } = await import("@/app/api/premium/compute/route"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("accepted payment resource lifecycle", () => {
  it("records one observation before running the handler and updates only its id", async () => {
    const run = vi.fn(async () => {
      expect(calls.map(c => c.method)).toEqual(["POST"]);
      return NextResponse.json({ resource: "ok" });
    });
    const response = await withGateway(run, "$0.0003", "/api/premium/test")(paid());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resource: "ok" });
    expect(receipt(response)).toMatchObject({ success: true, transaction: REFERENCE, payer: PAYER });
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls.map(c => c.method)).toEqual(["POST", "PATCH"]);
    expect(calls[0].url.searchParams.get("select")).toBe("id");
    expect(calls[1].url.searchParams.get("id")).toBe(`eq.${ID}`);
    expect(Object.keys(calls[1].body)).toEqual(["raw"]);
    expect(calls[1].body.raw).toEqual({
      ...(calls[0].body.raw as object), resourceOutcome: { kind: "response", httpStatus: 200 },
    });
    expect(calls[0].body).toMatchObject({ amount_usdc: "0.0003", payer: PAYER, gateway_tx: REFERENCE });
    expect(JSON.stringify(calls.map(c => c.body))).not.toContain(payment);
  });

  it("preserves acknowledgement when a handler throws without exposing its exception", async () => {
    const run = vi.fn(async () => { throw new Error("private handler details"); });
    const response = await withGateway(run, "$0.01", "/api/premium/test")(paid());
    expect(response.status).toBe(500);
    expect(receipt(response)).toMatchObject({ success: true, transaction: REFERENCE });
    expect(await response.text()).not.toContain("private handler details");
    expect(calls[1].body.raw).toMatchObject({ resourceOutcome: { kind: "handler_error", httpStatus: 500 } });
    expect(JSON.stringify(calls.map(c => c.body))).not.toContain("private handler details");
    expect(run).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it.each([204, 302, 422, 503])("keeps a returned %i response separate from acceptance", async status => {
    const response = await withGateway(async () => new NextResponse(null, { status }), "$0.01", "/test")(paid());
    expect(response.status).toBe(status);
    expect(receipt(response).success).toBe(true);
    expect(calls[1].body.raw).toMatchObject({ resourceOutcome: { kind: "response", httpStatus: status } });
  });

  it("does not invent a missing payment reference", async () => {
    facilitator.settle.mockResolvedValue({ success: true, payer: PAYER });
    const response = await withGateway(handler(), "$0.01", "/test")(paid());
    expect(receipt(response)).not.toHaveProperty("transaction");
  });

  it("associates concurrent outcomes with their own insert ids when responses arrive out of order", async () => {
    const otherId = "33333333-3333-4333-8333-333333333333";
    let release!: (response: Response) => void;
    respond = call => call.method === "POST" && call.body.endpoint === "/first"
      ? new Promise(resolve => { release = resolve; })
      : Promise.resolve(call.method === "POST" ? json({ id: otherId }, 201) : new Response(null, { status: 204 }));
    const first = withGateway(async () => new NextResponse(null, { status: 422 }), "$0.01", "/first")(paid());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = await withGateway(handler(), "$0.03", "/second")(paid());
    expect(second.status).toBe(200);
    release(json({ id: ID }, 201));
    expect((await first).status).toBe(422);
    const updates = calls.filter(c => c.method === "PATCH");
    expect(updates.map(c => c.url.searchParams.get("id"))).toEqual([`eq.${otherId}`, `eq.${ID}`]);
    expect(updates.map(c => c.body.raw)).toEqual([
      { ...(calls[1].body.raw as object), resourceOutcome: { kind: "response", httpStatus: 200 } },
      { ...(calls[0].body.raw as object), resourceOutcome: { kind: "response", httpStatus: 422 } },
    ]);
  });

  it.each([null, {}, { id: "not-an-id" }, { id: 5 }])("does not update without a confirmed valid insert id: %j", async data => {
    respond = async () => json(data, 201);
    const run = handler();
    const response = await withGateway(run, "$0.01", "/test")(paid());
    expect(response.status).toBe(200);
    expect(receipt(response).success).toBe(true);
    expect(calls.map(c => c.method)).toEqual(["POST"]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["insert-error", "insert-throw", "update-error", "update-throw"])("does not suppress the resource or retry after %s", async failure => {
    respond = async call => {
      const fails = failure.startsWith("insert") ? call.method === "POST" : call.method === "PATCH";
      if (fails && failure.endsWith("throw")) throw new Error("private storage details");
      if (fails) return json({ message: "private storage details" }, 503);
      return call.method === "POST" ? json({ id: ID }, 201) : new Response(null, { status: 204 });
    };
    const run = handler();
    const response = await withGateway(run, "$0.01", "/test")(paid());
    expect(response.status).toBe(200);
    expect(receipt(response).success).toBe(true);
    expect(await response.text()).not.toContain("private storage details");
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls.map(c => c.method)).toEqual(failure.startsWith("insert") ? ["POST"] : ["POST", "PATCH"]);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it.each(["verify", "settle"])("does not acknowledge or record a rejected %s", async stage => {
    if (stage === "verify") facilitator.verify.mockResolvedValue({ isValid: false });
    else facilitator.settle.mockResolvedValue({ success: false });
    const run = handler();
    const response = await withGateway(run, "$0.01", "/test")(paid());
    expect(response.status).toBe(402);
    expect(response.headers.has("PAYMENT-RESPONSE")).toBe(false);
    expect(calls).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("sanitizes an uncertain payment error without claiming acceptance", async () => {
    facilitator.settle.mockRejectedValue(new Error("private facilitator details"));
    const response = await withGateway(handler(), "$0.01", "/test")(paid());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Payment processing error" });
    expect(response.headers.has("PAYMENT-RESPONSE")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each(["POST", "PATCH"])("bounds stalled %s headers and never issues late follow-up writes", async method => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    respond = call => call.method === method ? new Promise(resolve => { release = resolve; }) : Promise.resolve(json({ id: ID }, 201));
    const run = handler();
    let observed: NextResponse | undefined;
    const pending = withGateway(run, "$0.01", "/test")(paid()).then(value => { observed = value; return value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)?.method).toBe(method);
    await vi.advanceTimersByTimeAsync(1999);
    expect(observed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(observed?.status).toBe(200);
    expect(receipt(await pending).success).toBe(true);
    const count = calls.length;
    release(json({ id: ID }, 201));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(count);
    expect(calls.filter(c => c.method === "POST")).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["POST", "PATCH"])("bounds stalled %s response bodies even when the transport ignores abort", async method => {
    vi.useFakeTimers();
    respond = async call => call.method === method
      ? new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } })
      : json({ id: ID }, 201);
    let observed: NextResponse | undefined;
    const pending = withGateway(handler(), "$0.01", "/test")(paid()).then(value => { observed = value; return value; });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(observed?.status).toBe(200);
    expect(receipt(await pending).success).toBe(true);
    expect(calls.at(-1)?.signal?.aborted).toBe(true);
  });
});

describe("compute validates before payment processing", () => {
  const request = (body?: BodyInit | null, headers: Record<string, string> = {}) => new NextRequest("http://localhost/api/premium/compute", {
    method: "POST", headers: { "content-type": "application/json", "payment-signature": payment, ...headers }, body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
  const rejected = async (req: NextRequest, status: number) => {
    const response = await compute(req);
    expect(response.status).toBe(status);
    expect(response.headers.has("PAYMENT-RESPONSE")).toBe(false);
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  };

  it.each(["{", "null", "[]", "{}", '{"text":7}', '{"text":{}}', '{"text":""}', JSON.stringify({ text: "x".repeat(2001) })].flatMap(body => [true, false].map(signed => ({ body, signed }))))("rejects invalid compute input before payment (case %#)", async ({ body, signed }) => {
    const response = await compute(new NextRequest("http://localhost/api/premium/compute", {
      method: "POST", headers: { "content-type": "application/json", ...(signed ? { "payment-signature": payment } : {}) }, body,
    }));
    expect(response.status).toBe(400);
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("reads valid Unicode text once, preserving literal text and the existing resource shape", async () => {
    const text = "  Hello 🌍.  ";
    const response = await compute(new NextRequest("http://localhost/api/premium/compute", {
      method: "POST", headers: { "content-type": "application/json; charset=utf-8", "payment-signature": payment }, body: JSON.stringify({ text }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ word_count: 2, char_count: text.length });
    expect(receipt(response).success).toBe(true);
    expect(facilitator.verify.mock.calls[0][1].amount).toBe("300");
  });

  it.each([" ", "x", "🌍".repeat(1000)])("accepts valid text boundaries without trimming (%#. case)", async text => {
    const response = await compute(request(JSON.stringify({ text })));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ char_count: text.length });
  });

  it("quotes valid unpaid input and rejects invalid unpaid input before quoting", async () => {
    const valid = request('{"text":"hi"}'); valid.headers.delete("payment-signature");
    const response = await compute(valid);
    expect(response.status).toBe(402);
    const quote = JSON.parse(Buffer.from(response.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
    expect(quote.accepts[0].amount).toBe("300");
    const invalid = request("{}"); invalid.headers.delete("payment-signature");
    await rejected(invalid, 400);
  });

  it.each(["text/plain", "application/jsonp", ""])("rejects unsupported media type %s", async contentType => {
    await rejected(request('{"text":"hi"}', { "content-type": contentType }), 415);
  });

  it("rejects a missing body, invalid UTF-8 and a broken stream", async () => {
    await rejected(request(), 400);
    await rejected(request(new Uint8Array([0xff])), 400);
    await rejected(request(new ReadableStream({ start(controller) { controller.error(new Error("private read failure")); } })), 400);
  });

  it("counts actual UTF-8 bytes including ignored fields, regardless of Content-Length", async () => {
    const prefix = '{"text":"ok","ignored":"';
    const suffix = '"}';
    const boundary = prefix + "x".repeat(16384 - prefix.length - suffix.length) + suffix;
    expect((await compute(request(boundary))).status).toBe(200);
    calls = []; facilitator.verify.mockClear(); facilitator.settle.mockClear();
    await rejected(request(boundary + " ", { "content-length": "1" }), 413);
    await rejected(request(JSON.stringify({ text: "ok", ignored: "🌍".repeat(4096) })), 413);
    await rejected(request('{"text":"ok"}', { "content-length": "16385" }), 413);
  });

  it("accepts escaped JSON and rejects UTF-16 length overflow", async () => {
    expect((await compute(request('{"text":"\\u0068\\u0069"}'))).status).toBe(200);
    calls = []; facilitator.verify.mockClear(); facilitator.settle.mockClear();
    await rejected(request(JSON.stringify({ text: "🌍".repeat(1000) + "x" })), 400);
  });

  it.each(["timeout", "oversize"])("does not wait for reader cancellation on %s", async failure => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { if (failure === "oversize") controller.enqueue(new Uint8Array(16385)); }, cancel,
    });
    let observed: NextResponse | undefined;
    const pending = compute(request(stream)).then(value => { observed = value; return value; });
    await vi.advanceTimersByTimeAsync(failure === "timeout" ? 4999 : 0);
    if (failure === "timeout") {
      expect(observed).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect((await pending).status).toBe(failure === "timeout" ? 408 : 413);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("uses one whole-body deadline rather than restarting it for each chunk", async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const pending = compute(request(stream));
    await vi.advanceTimersByTimeAsync(4000);
    controller.enqueue(new TextEncoder().encode('{"text":'));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).status).toBe(408);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
});
