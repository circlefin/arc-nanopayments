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

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceOutcomeBadge } from "@/components/dashboard/resource-outcome-badge";
import { readResourceOutcome, resourceOutcomeLabel, retainResourceOutcome } from "@/lib/resource-outcome";

describe("public resource observations", () => {
  it.each([undefined, null, {}, [], "bad", { resourceOutcome: null }, { resourceOutcome: [] },
    { resourceOutcome: { kind: "delivery", httpStatus: 200 } },
    { resourceOutcome: { kind: "response", httpStatus: "200" } },
    ...[199, 600, 200.5, NaN].map(httpStatus => ({ resourceOutcome: { kind: "response", httpStatus } })),
    { resourceOutcome: { kind: "handler_error", httpStatus: 503 } },
  ])("treats missing/malformed legacy metadata as unknown: %j", raw => {
    expect(readResourceOutcome(raw)).toBeUndefined();
    expect(resourceOutcomeLabel(raw)).toBe("Not observed");
  });

  it.each([
    ["response", 200, "Response produced · 200"],
    ["response", 302, "Response produced · 302"],
    ["response", 422, "Error response · 422"],
    ["response", 500, "Error response · 500"],
    ["handler_error", 500, "Handler failed · 500"],
  ])("renders the actual badge for %s %i", (kind, httpStatus, label) => {
    const raw = { resourceOutcome: { kind, httpStatus, exception: "untrusted extra field" } };
    expect(readResourceOutcome(raw)).toEqual({ kind, httpStatus });
    const markup = renderToStaticMarkup(createElement(ResourceOutcomeBadge, { raw }));
    expect(markup).toContain(label);
    expect(markup).toContain("Server observation only; does not confirm buyer receipt or onchain settlement.");
    expect(markup).not.toContain("untrusted extra field");
    expect(markup).toContain(httpStatus >= 400 ? "bg-destructive" : "bg-secondary");
  });

  it("renders unknown history without a success claim", () => {
    const markup = renderToStaticMarkup(createElement(ResourceOutcomeBadge, { raw: null }));
    expect(markup).toContain("Not observed");
    expect(markup).not.toContain("bg-secondary");
  });

  it("retains canonical terminal metadata but accepts a newer valid observation", () => {
    const previous: { raw: Record<string, unknown> } = { raw: { resourceOutcome: { kind: "response", httpStatus: 200 }, requirements: { amount: "300" } } };
    expect(retainResourceOutcome(previous, { raw: { resourceOutcome: false, incoming: true } }).raw).toEqual({
      ...previous.raw, incoming: true,
    });
    const incoming = { raw: { resourceOutcome: { kind: "handler_error", httpStatus: 500 } } };
    expect(retainResourceOutcome(previous, incoming)).toBe(incoming);
  });
});
