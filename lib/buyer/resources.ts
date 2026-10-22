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

export const resources = [
  { id: "quote", name: "Quote", method: "GET", path: "/api/premium/quote", price: "0.001" },
  { id: "dataset", name: "Dataset", method: "GET", path: "/api/premium/dataset", price: "0.01" },
  { id: "compute", name: "Compute", method: "POST", path: "/api/premium/compute", price: "0.0003" },
  { id: "agent-task", name: "Agent task", method: "GET", path: "/api/premium/agent-task", price: "0.03" },
] as const;
export type Resource = (typeof resources)[number];

export function resourceBody(resource: Resource, text: string) {
  if (resource.method !== "POST") return undefined;
  if (text.length > 2000) throw new Error("Compute input must be at most 2,000 characters.");
  return JSON.stringify({ text });
}
