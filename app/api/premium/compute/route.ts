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

const handler = async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}));
  const text = (body as { text?: string }).text ?? "No input provided.";

  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?]+/).filter(Boolean);

  return NextResponse.json({
    summary: `Input contains ${words.length} words across ${sentences.length} sentence(s).`,
    word_count: words.length,
    sentence_count: sentences.length,
    char_count: text.length,
    timestamp: new Date().toISOString(),
  });
};

export const POST = withGateway(handler, `$${resources[2].price}`, resources[2].path);
