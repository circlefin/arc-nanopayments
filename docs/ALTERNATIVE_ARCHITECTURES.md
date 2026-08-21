# Alternative Nanopayment Architecture: Vault + Batched Voucher Settlement

  This note documents an alternative approach to agent-to-agent nanopayments on
  Arc, developed while integrating with this sample app. It is offered as a
  reference for anyone evaluating tradeoffs against the Gateway/x402 batching
  facilitator model used here — it is **not** a replacement or a claim that one
  approach is strictly better, just a different point in the design space.

  Reference implementation: https://github.com/osr21/arc-stablecoin-dapp
  (`contracts/src/NanopayVault.sol`, Nanopayments page in the DApp UI).

  ## This repo's model (Gateway x402 batching)

  - Buyer signs an x402 payment payload **per HTTP request**.
  - `BatchFacilitatorClient.verify()` / `.settle()` is called on every request
    in `lib/x402.ts`'s `withGateway()` wrapper.
  - Circle's Gateway facilitator batches settlement under the hood across many
    callers, so the seller doesn't pay gas per call, but the buyer's client
    still does a full verify/settle round trip synchronously per request.
  - Strength: no bespoke on-chain contract, no relayer to run — Circle's
    Gateway infra does verification/settlement.

  ## NanopayVault's model (session voucher + keeper batch settle)

  - Buyer deposits once into a vault contract (`deposit()`), then signs **one**
    EIP-712 `SessionVoucher` off-chain (zero gas) describing a rate + budget +
    expiry for a whole session with a given seller — not one signature per call.
  - A trusted operator key (the same relay used for facilitator-style flows)
    submits `openSession()` once, verified on-chain via `ecrecover`.
  - Usage during the session is metered **off-chain only** as a running
    `pendingAmount` — no transaction, no signature, and no facilitator round
    trip per request. This is the main structural difference: per-request cost
    drops to zero on-chain and off-chain (just an in-memory counter bump).
  - A keeper job (`tickNanopay()`) periodically calls `settleBatch()` across
    many open sessions in a single transaction, moving buyer → seller vault
    balances. Settlement cadence is decoupled entirely from request cadence.
  - `closeSession()` is callable by the operator at any time, or by anyone once
    the voucher's expiry has passed — so a session can't be held open
    indefinitely if the operator disappears.
  - The operator role transfers via two-step `proposeOperator()` /
    `acceptOperator()` rather than a single-step setter, following the same
    ownership-transfer hardening pattern flagged in this org's own
    `arc-node` security advisories (a mistyped or unreachable address can't
    permanently brick the role).

  ## Tradeoffs

  | | Gateway x402 batching (this repo) | Vault + voucher (NanopayVault) |
  |---|---|---|
  | Per-request cost | One verify/settle round trip per call | Zero — in-memory counter bump |
  | Trust model | Circle's Gateway facilitator | Single trusted operator/relay key (documented tradeoff, not decentralized) |
  | Settlement granularity | Per request (batched by Circle internally) | Per keeper tick, batched across many sessions in one tx |
  | Infra to run | None beyond the facilitator client | Custom contract + keeper job |
  | Best fit | Pay-per-call APIs, arbitrary one-off resources | Sustained agent-to-agent sessions with predictable rate/budget |

  Both approaches solve the same core problem (avoiding gas-per-micropayment)
  by pushing settlement off the request's hot path — this repo does it via a
  managed facilitator, NanopayVault does it via a self-hosted keeper batching
  signed session vouchers. Worth comparing if you're deciding between "use
  Circle's Gateway" vs. "run your own settlement batching" for an agent-to-agent
  payments use case.

  ## MachineWallet's model (spender-side policy wallet, direct settlement)

  The models above optimize the **seller-side settlement path**. A further
  variant from the same reference repo addresses the other half of the
  machine-economy problem: bounding what an autonomous buyer's hot key can
  spend. On Arc, gas is sub-cent USDC and finality is sub-second (measured
  ~1 s end-to-end with viem `pollingInterval: 200`, best 547 ms across 19
  consecutive settlements), so paying per micropayment directly on-chain is
  viable at moderate tick rates — the binding risk is not gas cost but a
  compromised or runaway device key.

  Reference implementation:
  [`contracts/src/MachineWallet.sol`](https://github.com/osr21/arc-stablecoin-dapp/blob/machine-economy/contracts/src/MachineWallet.sol)
  and the keeper/simulator
  [`artifacts/api-server/src/lib/machine-sim.ts`](https://github.com/osr21/arc-stablecoin-dapp/blob/machine-economy/artifacts/api-server/src/lib/machine-sim.ts),
  deployed on Arc Testnet at `0xb5E319f40E39F1b212AA2f6982e848066eB655Fb`.

  - The owner deploys a `MachineWallet` contract holding the device's USDC
    budget. The device key is a separate role whose only entrypoint is the
    payment function — it has no withdrawal or configuration path.
  - Policy is enforced **on-chain, not in the server**: payee allowlist,
    per-payment cap, cumulative cap per fixed (tumbling) time window, max
    unit price, and an owner-only kill switch (`setPaused`).
  - Worst case on device-key compromise: the attacker can pay only
    allowlisted payees, at most the per-payment cap per call and the window
    cap per window, until the owner pauses. Funds cannot be withdrawn or
    redirected.
  - Rejections surface as decoded custom errors via `simulateContract`
    before any gas is spent, so a tripped policy (or the kill switch) costs
    the device nothing.

  | | Gateway x402 batching | Vault + voucher | MachineWallet policy wallet |
  |---|---|---|---|
  | Optimizes for | Seller settlement cost | Seller settlement cost | Buyer spend containment |
  | Per-request cost | Verify/settle round trip | Zero (off-chain meter) | One on-chain transfer (sub-cent gas) |
  | Key at risk | Seller server key | Operator relay key | Device key (bounded by on-chain policy) |
  | Best fit | Pay-per-call APIs | Sustained metered sessions | Autonomous device/agent buyers |

  These are composable rather than competing: a machine buyer can hold funds
  behind a MachineWallet-style policy while paying a seller that settles via
  any of the models above. The on-chain spend policy also bounds the blast
  radius of any server-side key compromise of the kind reported in issue
  [#29](https://github.com/circlefin/arc-nanopayments/issues/29) — even a
  fully compromised caller cannot exceed the allowlist and caps.
