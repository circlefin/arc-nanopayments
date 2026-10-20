/** Copyright 2026 Circle Internet Group, Inc. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_ID, HASH, paymentFixture, snapshotFixture } from "../helpers/settlement-fixtures";

// The actual TSX/handlers run with controlled hooks and inert primitives. This is
// a node unit harness, not a DOM/Radix renderer; all requests and clipboard writes
// are mocked. One context belongs to one mounted component instance.
const hooks = vi.hoisted(() => ({ current: { values: [] as unknown[], index: 0, cleanups: [] as (() => void)[] } }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useState(initial: unknown) {
    const context = hooks.current, index = context.index++;
    if (!(index in context.values)) context.values[index] = initial;
    return [context.values[index], (value: unknown) => { context.values[index] = value; }];
  },
  useRef(initial: unknown) {
    const context = hooks.current, index = context.index++;
    if (!(index in context.values)) context.values[index] = { current: initial };
    return context.values[index];
  },
  useEffect(effect: () => void | (() => void)) {
    const context = hooks.current, index = context.index++;
    if (!(index in context.values)) {
      context.values[index] = true;
      const cleanup = effect();
      if (cleanup) context.cleanups.push(cleanup);
    }
  },
}));
vi.mock("@/components/ui/button", () => ({ Button: "button" }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: "dialog", DialogTrigger: "trigger", DialogContent: "section",
  DialogHeader: "header", DialogTitle: "h2", DialogDescription: "p",
}));
import { PaymentDetailsDialog } from "@/components/dashboard/payment-details-dialog";

type Element = { type: unknown; props: Record<string, unknown> };
function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const element = value as Element;
  return [element, ...nodes(element.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object" && "props" in value) return text((value as Element).props.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
let payment = paymentFixture();
function render() { hooks.current.index = 0; return PaymentDetailsDialog({ payment }); }
function open(value = true) {
  const dialog = nodes(render()).find(node => node.type === "dialog")!;
  (dialog.props.onOpenChange as (open: boolean) => void)(value);
  return render();
}
function click(label: string) {
  const button = nodes(render()).find(node => node.type === "button" && text(node.props.children) === label)!;
  expect(button, `Button ${label}`).toBeDefined();
  return (button.props.onClick as () => Promise<void>)();
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
function unmount() { for (const cleanup of hooks.current.cleanups) cleanup(); }
beforeEach(() => {
  hooks.current = { values: [], index: 0, cleanups: [] };
  payment = paymentFixture();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshotFixture())));
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe("payment details dialog", () => {
  it("opens with existing metadata and Not checked, without a lookup or raw JSON", () => {
    const tree = open();
    expect(text(tree)).toContain("9007199254.740993 USDC");
    expect(text(tree)).toContain(payment.endpoint);
    expect(text(tree)).toContain("Not checked");
    expect(text(tree)).not.toContain("requirements");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prevents duplicate clicks before rerender and checks only the local event ID", async () => {
    open();
    const response = deferred();
    vi.mocked(fetch).mockReturnValue(response.promise);
    const button = nodes(render()).find(node => node.type === "button" && text(node.props.children) === "Check settlement")!;
    const submit = button.props.onClick as () => Promise<void>;
    const first = submit();
    await submit(); // no intervening render to update the button's disabled prop
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`/api/gateway/payments/${EVENT_ID}/settlement`, expect.objectContaining({ cache: "no-store" }));
    response.resolve(Response.json(snapshotFixture("batched", HASH)));
    await first;
    expect(text(render())).toContain("Included in a batch for processing");
    expect(text(render())).toContain("Last checked");
    expect(text(render())).toContain("Batch transaction hash");
    expect(text(render())).not.toContain("Confirmed onchain");
    await click("Copy batch hash");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(HASH);
  });

  it("retains a previous snapshot with last-successful freshness when a refresh fails", async () => {
    open();
    await click("Check settlement");
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
    await click("Check again");
    expect(text(render())).toContain("Accepted by Gateway; awaiting batching");
    expect(text(render())).toContain("Last successful check");
    expect(text(render())).toContain("Could not check settlement");
  });

  it("handles PR42's plain HTTP401 before trying to parse an error code", async () => {
    open();
    vi.mocked(fetch).mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    await click("Check settlement");
    expect(text(render())).toContain("Your session has expired. Please sign in again.");
    expect(text(render())).toContain("No successful check yet.");
    expect(text(render())).not.toContain("Gateway reports this transfer failed");
  });

  it.each([
    [409, { code: "lookup_unavailable" }, "unavailable for this record"],
    [404, { code: "transfer_not_found" }, "does not establish payment failure"],
    [404, { code: "payment_not_found" }, "record is no longer available"],
    [503, { error: "private upstream details" }, "Could not check settlement"],
  ])("shows a check outcome for HTTP %s, not a payment-failure badge", async (status, body, message) => {
    open();
    vi.mocked(fetch).mockResolvedValue(Response.json(body, { status }));
    await click("Check settlement");
    expect(text(render())).toContain(message);
    expect(text(render())).not.toContain("private upstream details");
    expect(text(render())).not.toContain("Gateway reports this transfer failed");
  });

  it("does not overwrite the new check with a late response after close/reopen of the same row", async () => {
    open();
    const old = deferred(), fresh = deferred();
    vi.mocked(fetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = click("Check settlement");
    const firstSignal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
    open(false);
    open();
    expect(firstSignal.aborted).toBe(true);
    expect(text(render())).toContain("Not checked");
    const second = click("Check settlement");
    fresh.resolve(Response.json(snapshotFixture("confirmed")));
    await second;
    old.resolve(Response.json(snapshotFixture("failed"))); // stub deliberately ignores abort
    await first;
    expect(text(render())).toContain("Confirmed onchain");
    expect(text(render())).not.toContain("Gateway reports this transfer failed");
  });

  it("aborts on unmount when switching rows and starts the new row unchecked", async () => {
    open();
    const old = deferred();
    vi.mocked(fetch).mockReturnValueOnce(old.promise);
    const pending = click("Check settlement");
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
    unmount();
    hooks.current = { values: [], index: 0, cleanups: [] };
    payment = { ...paymentFixture(), id: "33333333-3333-4333-8333-333333333333" };
    open();
    expect(signal.aborted).toBe(true);
    old.resolve(Response.json(snapshotFixture("completed")));
    await pending;
    expect(text(render())).toContain("Not checked");
    expect(text(render())).not.toContain("Completed by Gateway");
  });

  it("keeps an old non-UUID reference readable/copyable and disables lookup", async () => {
    payment = { ...paymentFixture(), gateway_tx: HASH };
    open();
    const check = nodes(render()).find(node => node.type === "button" && text(node.props.children) === "Check settlement")!;
    expect(check.props.disabled).toBe(true);
    expect(text(render())).toContain("Payment reference");
    await click("Copy payment reference");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(HASH);
    expect(fetch).not.toHaveBeenCalled();
  });
});
