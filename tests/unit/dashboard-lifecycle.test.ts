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

import { beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = vi.hoisted(() => ({ events: [] as unknown[], loading: false }));
vi.mock("@/hooks/use-transactions", () => ({ usePaymentEvents: () => state }));
vi.mock("@/hooks/use-withdrawals", () => ({ useWithdrawals: () => ({ withdrawals: [], loading: false }) }));
import Dashboard from "@/app/dashboard/page";
import { TooltipProvider } from "@/components/ui/tooltip";

const render = () => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Dashboard)));
beforeEach(() => { state.loading = false; state.events = []; });

it("renders the outcome next to its payment and preserves the amount column", () => {
  state.events = [{
    id: "synthetic", created_at: "2026-10-24T00:00:00Z", endpoint: "/api/premium/compute",
    payer: "synthetic-payer", amount_usdc: "0.0003", gateway_tx: null,
    raw: { resourceOutcome: { kind: "handler_error", httpStatus: 500 } },
  }];
  const markup = render();
  expect(markup).toContain("Resource outcome");
  expect(markup).toContain("Handler failed · 500");
  expect(markup).toContain("$0.0003");
  expect(markup.match(/<td\b/g)).toHaveLength(6);
});

it.each([true, false])("spans all payment columns when loading=%s", loading => {
  state.loading = loading; state.events = [];
  const markup = render();
  expect(markup).toContain('colSpan="6"');
  expect(markup).toContain(loading ? "Loading payments..." : "No payments found.");
});
