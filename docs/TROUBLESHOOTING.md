# Troubleshooting

## settle() returns unsupported_network for eip155:5042002

**Issue:** When running the payment agent against Arc Testnet endpoints, settle() returns unsupported_network for eip155:5042002 despite the network appearing in the /v1/x402/supported response.

**Root Cause:** The Circle Gateway POST /v1/x402/settle API endpoint may intermittently return unsupported_network for Arc Testnet (Chain ID: 5042002) even when the network is listed as supported. This is a known issue with SDK version 3.0.4.

**Workaround:** Verify your environment variables are correct:

SELLER_ADDRESS=0x...
CIRCLE_API_KEY=TEST_API_KEY:your-id:your-secret
CIRCLE_ENTITY_SECRET=your-entity-secret

Also verify Arc Testnet network config in lib/x402.ts:

const ARC_TESTNET_NETWORK = "eip155:5042002";
const ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

**Status:** Under investigation. Track at https://github.com/circlefin/arc-nanopayments/issues/1

## Node version errors

Requires Node.js v22+. Check: node --version

## npm vulnerabilities

Fresh install shows 16 vulnerabilities. Run npm audit fix for non-breaking fixes.

## Docker not running

Local Supabase requires Docker Desktop. Start before running: npx supabase start

## Missing SELLER_ADDRESS

Generate wallets first: npx tsx generate-wallets.mts
This writes wallet addresses and private keys to .env.local
