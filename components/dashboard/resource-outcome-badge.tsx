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

import { Badge } from "@/components/ui/badge";
import { readResourceOutcome, resourceOutcomeLabel } from "@/lib/resource-outcome";

export function ResourceOutcomeBadge({ raw }: { raw: unknown }) {
  const outcome = readResourceOutcome(raw);
  return (
    <Badge
      variant={!outcome ? "outline" : outcome.httpStatus >= 400 ? "destructive" : "secondary"}
      title="Server observation only; does not confirm buyer receipt or onchain settlement."
    >
      {resourceOutcomeLabel(raw)}
    </Badge>
  );
}
