import { GatewayClient } from "@circle-fin/x402-batching/client";
import {
  createWalletClient,
  createPublicClient,
  http,
  erc20Abi,
  parseUnits,
  parseEther,
} from "viem";
import { arcTestnet } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as readline from "node:readline/promises";

// --- Parse CLI args ---
function parseArgs() {
  const args = process.argv.slice(2);
  let spendingLimit: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      const val = parseFloat(args[i + 1]);
      if (isNaN(val) || val <= 0) {
        console.error("--limit must be a positive number (USDC amount)");
        process.exit(1);
      }
      spendingLimit = val;
      i++;
    }
  }

  return { spendingLimit };
}

let { spendingLimit } = parseArgs();
let totalSpent = 0;
let paused = false;

function formatPaymentError(err: unknown) {
  if (err instanceof Error) {
    const cause = err.cause as
      | { shortMessage?: string; details?: string }
      | undefined;
    const parts = [err.message];

    if (cause?.shortMessage && !parts.includes(cause.shortMessage)) {
      parts.push(cause.shortMessage);
    }

    if (cause?.details && !parts.includes(cause.details)) {
      parts.push(cause.details);
    }

    return parts.join(" | ");
  }

  return String(err);
}

if (spendingLimit !== null) {
  console.log(`Spending limit: ${spendingLimit} USDC`);
}

async function promptForAllowance(): Promise<number> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      "\nSpending limit reached. Enter additional allowance in USDC (or 0 to quit): ",
    );
    const val = parseFloat(answer);
    if (isNaN(val) || val < 0) {
      console.error("Invalid amount. Exiting.");
      process.exit(0);
    }
    if (val === 0) {
      console.log(`Agent stopped. Total spent: ${totalSpent.toFixed(6)} USDC`);
      process.exit(0);
    }
    return val;
  } finally {
    rl.close();
  }
}

// --- Funder wallet (the one you funded via Circle faucet) ---
const funderKey = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!funderKey) {
  console.error(
    "Missing BUYER_PRIVATE_KEY. Run `npm run generate-wallets` first.",
  );
  process.exit(1);
}

const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;
const ARC_TESTNET_RPC = "https://rpc.testnet.arc.network";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT ?? "1";
// Amount of native USDC to send for gas (Arc testnet gas = USDC with 18 decimals)
const GAS_FUND_AMOUNT = parseEther("0.01");

const endpoints = [
  { url: `${BASE_URL}/api/premium/quote`, method: "GET" as const },
  { url: `${BASE_URL}/api/premium/dataset`, method: "GET" as const },
  {
    url: `${BASE_URL}/api/premium/compute`,
    method: "POST" as const,
    body: { text: "Hello from the Arc nanopayments demo!" },
  },
  { url: `${BASE_URL}/api/premium/agent-task`, method: "GET" as const },
];

// --- Generate ephemeral wallet ---
const ephemeralKey = generatePrivateKey();
const ephemeralAccount = privateKeyToAccount(ephemeralKey);
console.log(`Ephemeral agent wallet: ${ephemeralAccount.address}`);

// --- Fund the ephemeral wallet from the funder ---
const funderAccount = privateKeyToAccount(funderKey);
const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_TESTNET_RPC),
});
const funderWallet = createWalletClient({
  account: funderAccount,
  chain: arcTestnet,
  transport: http(ARC_TESTNET_RPC),
});

console.log(
  `Funding ephemeral wallet from funder ${funderAccount.address}...`,
);

const usdcAmount = parseUnits(DEPOSIT_AMOUNT, 6);

// Retry helper for nonce collisions when multiple agents fund from the same wallet concurrently.
// On collision the other agent's tx confirms first, shifting the nonce — a short retry resolves it.
async function withNonceRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const isNonceError =
        msg.includes("replacement transaction underpriced") ||
        msg.includes("nonce too low") ||
        msg.includes("already known");
      if (!isNonceError || attempt === MAX_RETRIES - 1) throw err;
      const delay = 1000 + Math.random() * 2000;
      console.log(`  ${label}: nonce collision, retrying in ${Math.round(delay)}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

// Send native USDC for gas, wait for confirmation, then send ERC-20 USDC.
// Sequential + retry ensures correct nonce ordering even with concurrent agents.
const gasTxHash = await withNonceRetry(
  () => funderWallet.sendTransaction({ to: ephemeralAccount.address, value: GAS_FUND_AMOUNT }),
  "Gas tx",
);
await publicClient.waitForTransactionReceipt({ hash: gasTxHash });
console.log(`  Gas funded (${gasTxHash.slice(0, 10)}...)`);

const usdcTxHash = await withNonceRetry(
  () => funderWallet.writeContract({
    address: ARC_TESTNET_USDC,
    abi: erc20Abi,
    functionName: "transfer",
    args: [ephemeralAccount.address, usdcAmount],
  }),
  "USDC tx",
);
await publicClient.waitForTransactionReceipt({ hash: usdcTxHash });
console.log(`  USDC transferred (${usdcTxHash.slice(0, 10)}...)`);


// --- Create GatewayClient with the ephemeral wallet ---
const gateway = new GatewayClient({
  chain: "arcTestnet",
  privateKey: ephemeralKey,
});

let index = 0;
let inFlight = 0;
let redepositing = false;
let paymentInterval: ReturnType<typeof setInterval>;
let balanceInterval: ReturnType<typeof setInterval>;

// Auto-redeposit when balance drops below 0.5 USDC (atomic units).
// Leaves plenty of runway for payments while the deposit tx confirms.
const REDEPOSIT_THRESHOLD = 500_000n;

async function depositToGateway() {
  console.log(`Depositing ${DEPOSIT_AMOUNT} USDC into Gateway Wallet...`);
  const result = await gateway.deposit(DEPOSIT_AMOUNT);
  console.log(`Deposit complete! TX: ${result.depositTxHash}`);
  const updated = await gateway.getBalances();
  console.log(
    `Gateway available balance: ${updated.gateway.formattedAvailable}`,
  );
}

async function refundAndRedeposit() {
  // Transfer more USDC from funder to ephemeral, then deposit into Gateway
  const txHash = await withNonceRetry(
    () => funderWallet.writeContract({
      address: ARC_TESTNET_USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [ephemeralAccount.address, usdcAmount],
    }),
    "Redeposit tx",
  );
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  await depositToGateway();
}

async function checkAndRedeposit() {
  if (redepositing || paused) return;
  redepositing = true;
  try {
    const balances = await gateway.getBalances();
    if (balances.gateway.available < REDEPOSIT_THRESHOLD) {
      console.log(
        `\nGateway balance low (${balances.gateway.formattedAvailable}), redepositing...`,
      );
      // Check if ephemeral wallet has USDC to deposit directly
      if (balances.wallet.balance > 0n) {
        await depositToGateway();
      } else {
        // Pull more from the funder
        await refundAndRedeposit();
      }
    }
  } catch (err) {
    console.error("Balance check failed:", (err as Error).message);
  } finally {
    redepositing = false;
  }
}

// Initial Gateway deposit
await depositToGateway();

console.log(
  `\nTarget: 1 transaction/second across ${endpoints.length} endpoints\n`,
);

// Check balance every 30 seconds and redeposit if low.
// Runs fully async — payments continue uninterrupted during deposit.
balanceInterval = setInterval(checkAndRedeposit, 30_000);

async function handleLimitReached() {
  if (spendingLimit === null) return;

  paused = true;
  clearInterval(paymentInterval);
  clearInterval(balanceInterval);

  // Wait for in-flight payments to settle
  while (inFlight > 0) {
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`\nSpent ${totalSpent.toFixed(6)} / ${spendingLimit.toFixed(6)} USDC (limit reached)`);

  const additional = await promptForAllowance();
  spendingLimit += additional;
  console.log(`New limit: ${spendingLimit.toFixed(6)} USDC (total spent so far: ${totalSpent.toFixed(6)} USDC)`);

  paused = false;
  startPaymentLoop();
}

function startPaymentLoop() {
  balanceInterval = setInterval(checkAndRedeposit, 30_000);

  paymentInterval = setInterval(() => {
    if (paused) return;

    const ep = endpoints[index % endpoints.length];
    const requestId = ++index;
    const endpointName = ep.url.split("/").pop();
    inFlight++;

    const start = Date.now();
    gateway
      .pay(ep.url, { method: ep.method, body: ep.body })
      .then((result) => {
        inFlight--;
        const ms = Date.now() - start;
        const amount = parseFloat(result.formattedAmount);
        totalSpent += amount;

        const limitInfo = spendingLimit !== null
          ? ` [spent: ${totalSpent.toFixed(6)}/${spendingLimit.toFixed(6)} USDC]`
          : "";
        console.log(
          `#${requestId} ${ep.method} ${endpointName} -> ${result.formattedAmount} USDC (${ms}ms) [in-flight: ${inFlight}]${limitInfo}`,
        );

        if (spendingLimit !== null && totalSpent >= spendingLimit) {
          handleLimitReached();
        }
      })
      .catch((err) => {
        inFlight--;
        const ms = Date.now() - start;
        const errorDetails = formatPaymentError(err);
        console.error(
          `#${requestId} ${ep.method} ${endpointName} FAILED (${ms}ms): ${errorDetails} [in-flight: ${inFlight}]`,
        );
      });
  }, 1000);
}

startPaymentLoop();
