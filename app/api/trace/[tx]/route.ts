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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";

const TRACE_DIR = join(process.cwd(), ".trace", "events");

export type TraceEvent = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  context_id?: string;
  seq: number;
  role: string;
  payload?: Record<string, unknown>;
  run: string;
};

function settleTransaction(event: Record<string, unknown>): string | undefined {
  const payload = event.payload as Record<string, unknown> | undefined;
  const settle = payload?.settle as Record<string, unknown> | undefined;
  return typeof settle?.transaction === "string" ? settle.transaction : undefined;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ tx: string }> },
) {
  const { tx } = await params;

  let runFiles: string[];
  try {
    runFiles = readdirSync(TRACE_DIR).filter((f) => f.endsWith(".ndjson"));
  } catch {
    return NextResponse.json({ events: [] });
  }

  const events: TraceEvent[] = [];
  for (const file of runFiles) {
    let lines: string[];
    try {
      lines = readFileSync(join(TRACE_DIR, file), "utf-8").split("\n");
    } catch {
      continue;
    }

    const fileEvents: Record<string, unknown>[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        fileEvents.push(JSON.parse(line));
      } catch {
        continue;
      }
    }

    // context_id is only unique within one run file, so match per file:
    // contexts that settled this tx, then every event of those contexts.
    const matchedContexts = new Set(
      fileEvents
        .filter((e) => settleTransaction(e) === tx)
        .map((e) => e.context_id as string)
        .filter(Boolean),
    );
    if (matchedContexts.size === 0) continue;

    for (const e of fileEvents) {
      if (matchedContexts.has(e.context_id as string)) {
        events.push({ ...(e as Omit<TraceEvent, "run">), run: file });
      }
    }
  }

  events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  return NextResponse.json({ events });
}
