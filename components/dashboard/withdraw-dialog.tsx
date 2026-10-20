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

"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { BanknoteArrowDown, Loader2 } from "lucide-react";
import { toast } from "sonner";

const CHAIN_EXPLORERS: Record<string, string> = {
  arcTestnet: "https://testnet.arcscan.io/tx/",
  baseSepolia: "https://sepolia.basescan.org/tx/",
  sepolia: "https://sepolia.etherscan.io/tx/",
  arbitrumSepolia: "https://sepolia.arbiscan.io/tx/",
  optimismSepolia: "https://sepolia-optimism.etherscan.io/tx/",
  avalancheFuji: "https://testnet.snowscan.xyz/tx/",
  polygonAmoy: "https://amoy.polygonscan.com/tx/",
};

const SUPPORTED_CHAINS = [
  { value: "arcTestnet", label: "Arc Testnet" },
  { value: "baseSepolia", label: "Base Sepolia" },
  { value: "sepolia", label: "Ethereum Sepolia" },
  { value: "arbitrumSepolia", label: "Arbitrum Sepolia" },
  { value: "optimismSepolia", label: "Optimism Sepolia" },
  { value: "avalancheFuji", label: "Avalanche Fuji" },
  { value: "polygonAmoy", label: "Polygon Amoy" },
];

interface WithdrawDialogProps {
  /** null until a balance has loaded; "0" is a known zero balance. */
  maxAvailable: string | null;
  onWithdraw: () => void;
}

export function WithdrawDialog({ maxAvailable, onWithdraw }: WithdrawDialogProps) {
  const [open, setOpen] = useState(false);
  const [chain, setChain] = useState("arcTestnet");
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleWithdraw() {
    const parsedAmount = Number(amount);
    if (Number.isNaN(parsedAmount) || parsedAmount <= 0) {
      toast.error("Invalid amount", {
        description: "Please enter a positive number.",
      });
      return;
    }

    if (maxAvailable !== null && parsedAmount > Number(maxAvailable)) {
      toast.error("Amount exceeds balance", {
        description: `Maximum available: ${maxAvailable} USDC`,
      });
      return;
    }

    if (address && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      toast.error("Invalid address", {
        description: "Destination address must be a valid Ethereum address (0x followed by 40 hex characters).",
      });
      return;
    }

    setSubmitting(true);

    try {
      const res = await fetch("/api/gateway/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          destinationChain: chain,
          destinationAddress: address || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error("Withdrawal failed", {
          description: data.error ?? "Unknown error",
        });
      } else {
        const explorerUrl = CHAIN_EXPLORERS[data.destinationChain]
          ? `${CHAIN_EXPLORERS[data.destinationChain]}${data.txHash}`
          : undefined;

        setAmount("");
        setOpen(false);
        onWithdraw();

        toast.success(`Withdrawn ${data.amount} USDC`, {
          description: `tx: ${data.txHash}`,
          duration: 10000,
        });
      }
    } catch (err) {
      toast.error("Withdrawal failed", {
        description: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <BanknoteArrowDown size={14} />
          Withdraw
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Withdraw Funds</DialogTitle>
          <DialogDescription>
            Move gateway funds to a recipient on a supported chain.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dest-chain" className="text-xs">
              Destination Chain
            </Label>
            <Select value={chain} onValueChange={setChain}>
              <SelectTrigger id="dest-chain" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPORTED_CHAINS.map((supportedChain) => (
                  <SelectItem key={supportedChain.value} value={supportedChain.value}>
                    {supportedChain.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dest-address" className="text-xs">
              Destination Address (optional, defaults to seller)
            </Label>
            <Input
              id="dest-address"
              placeholder="0x..."
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              className="font-mono text-xs"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="withdraw-amount" className="text-xs">
              Amount (USDC)
              {maxAvailable !== null && (
                <span className="text-muted-foreground ml-1">max: {maxAvailable}</span>
              )}
            </Label>
            <Input
              id="withdraw-amount"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="font-mono"
            />
          </div>

          <Button onClick={handleWithdraw} disabled={submitting || !amount} className="w-full">
            {submitting ? (
              <>
                <Loader2 size={14} className="animate-spin mr-2" />
                Withdrawing...
              </>
            ) : (
              "Withdraw"
            )}
          </Button>

        </div>
      </DialogContent>
    </Dialog>
  );
}
