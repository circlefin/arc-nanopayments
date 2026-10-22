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

const handler = async (_req: NextRequest) => {
  return NextResponse.json({
    dataset: [
      { id: 1, metric: "daily_active_users", value: 14200, unit: "users" },
      { id: 2, metric: "avg_session_duration", value: 8.4, unit: "minutes" },
      { id: 3, metric: "conversion_rate", value: 3.2, unit: "percent" },
      { id: 4, metric: "revenue_per_user", value: 0.47, unit: "usd" },
      { id: 5, metric: "churn_rate", value: 1.8, unit: "percent" },
    ],
    generated_at: new Date().toISOString(),
  });
};

export const GET = withGateway(handler, `$${resources[1].price}`, resources[1].path);
