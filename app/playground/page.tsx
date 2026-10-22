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

import { Suspense } from "react";
import { connection } from "next/server";
import { Playground } from "@/components/playground/playground";
import { publicBuyerConfig } from "@/lib/buyer/network";

async function ConfiguredPlayground() {
  // Read the public seller address at request time, rather than baking it into
  // Next's cached shell. Do not import the privileged seller payment wrapper.
  await connection();
  return <Playground {...publicBuyerConfig(process.env.SELLER_ADDRESS)} />;
}

export default function PlaygroundPage() {
  return <Suspense fallback={<p className="p-6">Loading buyer playground…</p>}><ConfiguredPlayground /></Suspense>;
}
