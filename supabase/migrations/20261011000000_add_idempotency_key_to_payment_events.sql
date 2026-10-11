-- Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.
--
-- SPDX-License-Identifier: Apache-2.0

-- payment_events.idempotency_key: client-supplied Idempotency-Key header value,
-- used by withGateway() to return the original settlement result for a retried
-- logical request instead of settling a second payment.
alter table public.payment_events
  add column if not exists idempotency_key text;

-- Partial unique index so a given (endpoint, payer, key) can only settle once.
create unique index if not exists payment_events_idempotency_key_unique
  on public.payment_events (endpoint, payer, idempotency_key)
  where idempotency_key is not null;
