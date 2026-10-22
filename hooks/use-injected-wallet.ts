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

import { useCallback, useEffect, useRef, useState } from "react";
import { chainNumber, firstAddress, isProvider, readProvider, switchToArc, type WalletChoice, type WalletContext } from "@/lib/buyer/wallet";
import { object, message } from "@/lib/buyer/http";

export function useInjectedWallet() {
  const [choices, setChoices] = useState<WalletChoice[]>([]);
  const [selected, setSelected] = useState("");
  const [session, setSession] = useState<{ address: WalletContext["address"] | null; chainId: number | null; generation: number }>({ address: null, chainId: null, generation: 0 });
  const [error, setError] = useState("");
  const [needsAdd, setNeedsAdd] = useState(false);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const selectionVersion = useRef(0);
  const connected = useRef(false);
  const connecting = useRef(false);
  const active = useRef(false);
  const invalidateSelection = useCallback(() => {
    generation.current++;
    selectionVersion.current++;
    connected.current = false;
  }, []);
  const provider = choices.find(choice => choice.id === selected)?.provider;

  useEffect(() => {
    active.current = true;
    const addChoice = (choice: WalletChoice) => setChoices(previous => {
      // A late announcement can name the fallback provider, but must not remove
      // a connected fallback or silently switch the selected provider.
      if (previous.some(item => item.provider === choice.provider)) {
        return previous.map(item => item.provider === choice.provider ? { ...item, name: choice.name } : item);
      }
      return previous.some(item => item.id === choice.id) ? previous : [...previous, choice];
    });
    const announce = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (object(detail) && object(detail.info) && typeof detail.info.uuid === "string" && detail.info.uuid.length <= 100 &&
          typeof detail.info.name === "string" && isProvider(detail.provider)) {
        addChoice({ id: detail.info.uuid, name: detail.info.name.slice(0, 80), provider: detail.provider });
      }
    };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const legacy: unknown = (window as Window & { ethereum?: unknown }).ethereum;
    if (isProvider(legacy)) setChoices(previous => previous.length ? previous : [{ id: "legacy", name: "Browser wallet", provider: legacy }]);
    return () => {
      active.current = false;
      invalidateSelection();
      window.removeEventListener("eip6963:announceProvider", announce);
    };
  }, [invalidateSelection]);

  useEffect(() => {
    if (!provider) return;
    const accounts = (value: unknown) => {
      generation.current++;
      if (!connected.current) return;
      const stamp = generation.current;
      setSession(previous => ({ ...previous, address: firstAddress(value), generation: stamp }));
    };
    const changedChain = (value: unknown) => {
      generation.current++;
      if (!connected.current) return;
      const stamp = generation.current;
      setSession(previous => ({ ...previous, chainId: chainNumber(value), generation: stamp }));
    };
    const disconnected = () => {
      generation.current++;
      selectionVersion.current++;
      connected.current = false;
      setSession({ address: null, chainId: null, generation: generation.current });
    };
    provider.on("accountsChanged", accounts);
    provider.on("chainChanged", changedChain);
    provider.on("disconnect", disconnected);
    return () => {
      provider.removeListener("accountsChanged", accounts);
      provider.removeListener("chainChanged", changedChain);
      provider.removeListener("disconnect", disconnected);
    };
  }, [provider]);

  const select = useCallback((id: string) => {
    generation.current++;
    selectionVersion.current++;
    connected.current = false;
    setSelected(id);
    setSession({ address: null, chainId: null, generation: generation.current });
    setError("");
    setNeedsAdd(false);
  }, []);
  const context = (): WalletContext | null => provider && session.address
    ? { provider, address: session.address, generation: session.generation } : null;
  const current = (value: WalletContext) => active.current && value.generation === generation.current;

  async function connect() {
    if (!provider || connecting.current) return;
    connecting.current = true;
    setPending(true);
    setError("");
    const stamp = selectionVersion.current;
    connected.current = true;
    try {
      await provider.request({ method: "eth_requestAccounts" });
      const readGeneration = generation.current;
      const reader = readProvider(provider, () => active.current && selectionVersion.current === stamp);
      const accounts = await reader.request({ method: "eth_accounts" });
      const network = await reader.request({ method: "eth_chainId" });
      if (active.current && selectionVersion.current === stamp) {
        if (readGeneration !== generation.current) throw new Error("Wallet changed while connecting. Connect again.");
        const address = firstAddress(accounts);
        if (!address) throw new Error("Wallet did not provide an account. Unlock it and connect again.");
        setSession({ address, chainId: chainNumber(network), generation: readGeneration });
      }
    } catch (error) { if (active.current && selectionVersion.current === stamp) { connected.current = false; setSession({ address: null, chainId: null, generation: generation.current }); setError(message(error)); } }
    finally { connecting.current = false; if (active.current) setPending(false); }
  }

  async function switchNetwork() {
    if (!provider || connecting.current) return;
    connecting.current = true;
    setPending(true);
    const stamp = selectionVersion.current;
    setError("");
    try {
      await switchToArc(provider, needsAdd);
      const readGeneration = generation.current;
      const value = await readProvider(provider, () => active.current && selectionVersion.current === stamp).request({ method: "eth_chainId" });
      if (active.current && stamp === selectionVersion.current) {
        if (readGeneration !== generation.current) throw new Error("Network changed while checking it. Review the selected network again.");
        generation.current++;
        const nextGeneration = generation.current;
        setSession(previous => ({ ...previous, chainId: chainNumber(value), generation: nextGeneration }));
        setNeedsAdd(false);
      }
    } catch (error) {
      if (active.current && stamp === selectionVersion.current) {
        if (object(error) && error.code === 4902) setNeedsAdd(true);
        setError(message(error));
      }
    } finally { connecting.current = false; if (active.current) setPending(false); }
  }

  function disconnect() {
    generation.current++;
    selectionVersion.current++;
    connected.current = false;
    setSession({ address: null, chainId: null, generation: generation.current });
    setError("");
  }

  return { choices, selected, select, provider, ...session, context, current, connect, disconnect, switchNetwork, needsAdd, error, pending };
}
