# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A demo of gasless USDC nanopayments on Arc Testnet using Circle's x402 batching (Gateway). A **Next.js App Router** app is the **seller** — it exposes x402-protected `/api/premium/*` endpoints and a `/dashboard` for monitoring payments and withdrawing earnings. A standalone script (`agent.mts`) is the **buyer** — it deposits USDC into Gateway and pays those endpoints in a loop. Settlement is batched offchain by Circle Gateway so sub-cent payments are viable.

## Commands

```bash
npm run dev              # dev server at http://localhost:3000
npm run build            # production build (output: standalone)
npm start                # run the built app
npm run lint             # eslint

npm run generate-wallets # create seller + buyer wallets, writes keys into .env.local
npm run agent            # run the buyer (pays the premium endpoints in a loop)
npm run agent -- --limit 0.5   # cap USDC spend; pauses and prompts for more when hit
```

There is no test suite. `agent.mts` and `generate-wallets.mts` run via `node --experimental-transform-types` (TS executed directly, no build step) and load `.env.local` via `--env-file`.

### Database (Supabase)

Two tables: `payment_events` (append-only settled-payment log) and `withdrawals` (withdrawal audit trail), both public-read with service-role writes, and both in the realtime publication. Migrations live in `supabase/migrations/`.

```bash
npx supabase db push     # apply migrations to the linked cloud project
```

Note: this project runs against **cloud Supabase**; the local Docker/`supabase start` path is documented in the README but currently broken in this environment.

## Architecture

**Payment lifecycle (seller side)** — `lib/x402.ts` is the core. A single `createGatewayMiddleware` instance (Circle's `@circle-fin/x402-batching/server`) is shared by every paywalled route. `withGateway(handler, price, endpoint)` wraps a route handler: it adapts the SDK's Express-style `(req, res, next)` middleware to a Next.js App Router handler, driving the full x402 flow (402 challenge → verify → settle → run handler via `next()`). Each premium route (`app/api/premium/*/route.ts`) is just a plain handler exported through `withGateway`.

**Haia Trace (HAD-336)** — `@usehaia/trace-x402` is attached on both sides via `trace(gateway, { writer: createRunWriter(...) })`: in `lib/x402.ts` (resolves the middleware as an x402 `httpResourceServer`) and in `agent.mts` (resolves `GatewayClient` as an x402 `client`). It passively records every lifecycle-hook firing (verify/settle on the seller, payment creation/response on the buyer) as NDJSON TraceEvents under `.trace/events/` (gitignored, dir hardcoded). It registers its own hooks alongside ours and can never alter the payment flow. The `onAfterSettle` hook in `lib/x402.ts` still persists settled payments to `payment_events` — that's ours, not Trace's.

**Buyer (`agent.mts`)** — despite the README describing a LangChain agent, the actual buyer is a throughput script: it generates an **ephemeral wallet** each run, funds it from `BUYER_PRIVATE_KEY` (native USDC for gas + ERC-20 USDC), deposits into Gateway, then pays the 4 endpoints round-robin at ~1 tx/sec. It auto-redeposits when the Gateway balance drops below the threshold, and uses `withNonceRetry` to survive nonce collisions when multiple agents fund from the same wallet concurrently. (The `@langchain/*` and `deepagents` deps are present but not used by `agent.mts`.)

**Withdrawals** — `app/api/gateway/withdraw/route.ts` uses `SELLER_PRIVATE_KEY` to withdraw Gateway USDC to any supported testnet chain (cross-chain via CCTP). It pre-checks native gas on source and destination chains, records a `submitted` row, then updates to `confirmed`/`failed`. Balance display is `app/api/gateway/balance/route.ts`.

**Auth** — demo-only. `app/actions.ts` checks a hardcoded `admin@example.com` / `123456` and sets an httpOnly `session=authenticated` cookie. `proxy.ts` (Next.js 16's renamed middleware — *not* `middleware.ts`) redirects based on that cookie: signed-in users away from `/`, signed-out users away from `/dashboard`.

**Dashboard** — client components under `components/dashboard/` read live data through hooks `hooks/use-transactions.ts` (`payment_events`) and `hooks/use-withdrawals.ts`, each opening a Supabase realtime channel. The hooks subscribe first and fetch initial rows only after `SUBSCRIBED`, then dedupe — done deliberately so no event is lost in the fetch/subscribe gap.

**Supabase clients** — `lib/supabase/server.ts` (SSR, cookie-based, create per-request — never a global), `lib/supabase/client.ts` (browser), `lib/supabase/proxy.ts`. Server-side payment/withdrawal writes use the service-role key via a plain `createClient` in the route/lib files.

## Key facts & conventions

- **Network**: Arc Testnet, `eip155:5042002`. USDC is `0x3600...0000`. Facilitator: `https://gateway-api-testnet.circle.com`. Arc gas is paid in USDC with **18 decimals** (payment amounts are 6-decimal USDC — mind the difference).
- **`NEXT_PUBLIC_*` env vars are inlined at build time** — they must be present during `npm run build` / `docker build`, not just at runtime. Server-only secrets (`SUPABASE_SERVICE_ROLE_KEY`, `SELLER_PRIVATE_KEY`, `SELLER_ADDRESS`) are runtime-only; the Dockerfile passes build-stage placeholders just to satisfy import-time client construction during page-data collection.
- Some modules construct Supabase/Gateway clients at **import time**, so builds fail without those placeholder envs present.
- **Docker**: multi-stage (`deps` → `builder` → `runner`), Next.js `output: "standalone"`, runs as non-root `nextjs` under `tini` (PID 1 signal handling / zombie reaping).
- UI is shadcn/ui (new-york style, `components/ui/`) + Tailwind v4 + lucide icons. Path alias `@/*`. All source files carry the Apache-2.0 Circle copyright header.
- Prices are dollar strings (`"$0.001"`) passed to `withGateway`; the `endpoint` arg is echoed back as `resource.url` and used as the `payment_events.endpoint` label.

## Git workflow

Commit straight to `master`, no feature branches. Push only on explicit approval.
