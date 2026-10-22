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

import { NextRequest, NextResponse } from "next/server";
import { withGateway } from "@/lib/x402";
import { resources } from "@/lib/buyer/resources";

const clues = [
  "The treasure is hidden where the sun meets the ocean — latitude 34.0195° N.",
  "Look for the old lighthouse on the western shore. The keeper left a journal.",
  "Page 42 of the journal mentions a cave behind the waterfall at mile marker 7.",
  "Inside the cave, follow the left passage. The markings on the wall spell coordinates.",
  "Final coordinates: 34.0195° N, 118.4912° W — X marks the spot.",
];

const handler = async (_req: NextRequest) => {
  const clue = clues[Math.floor(Math.random() * clues.length)];

  return NextResponse.json({
    clue,
    step: Math.floor(Math.random() * clues.length) + 1,
    total_steps: clues.length,
    timestamp: new Date().toISOString(),
  });
};

export const GET = withGateway(handler, `$${resources[3].price}`, resources[3].path);
