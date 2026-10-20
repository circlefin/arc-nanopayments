import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { normalizeGatewayBalances } from "../lib/gateway-balances.ts";

// Exercise the actual TSX component with controlled hooks and inert UI primitives.
// Every fetch below is mocked; no wallet or withdrawal service is invoked.
const componentUrl = new URL("../components/dashboard/withdraw-dialog.tsx", import.meta.url);
let state;
const modules = {
  react: {
    useState(initial) {
      const index = state.index++;
      if (!(index in state.values)) state.values[index] = initial;
      return [state.values[index], value => { state.values[index] = value; }];
    },
  },
  "react/jsx-runtime": jsxRuntime,
  "@/components/ui/input": { Input: "input" },
  "@/components/ui/button": { Button: "button" },
  "@/components/ui/label": { Label: "label" },
  "@/components/ui/select": {
    Select: "select", SelectContent: "div", SelectItem: "option", SelectTrigger: "div", SelectValue: "span",
  },
  "@/components/ui/dialog": {
    Dialog: "section", DialogContent: "div", DialogDescription: "p", DialogHeader: "header",
    DialogTitle: "h2", DialogTrigger: "div",
  },
  "lucide-react": { BanknoteArrowDown: "svg", Loader2: "svg" },
  sonner: { toast: { error: (...args) => state.errors.push(args), success: () => {} } },
};

const compiled = {};
runInNewContext(ts.transpileModule(readFileSync(componentUrl, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  fileName: "withdraw-dialog.tsx",
}).outputText, {
  exports: compiled,
  require(specifier) {
    assert.ok(Object.hasOwn(modules, specifier), `Unmocked component import: ${specifier}`);
    return modules[specifier];
  },
  async fetch(...args) {
    state.requests.push(args);
    return Response.json({ error: "Mock response; no withdrawal executed" }, { status: 400 });
  },
});

const { WithdrawDialog } = compiled;

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object") return [];
  return [node, ...elements(node.props?.children)];
}

function text(node) {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object") return text(node.props?.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}

async function submit(maxAvailable, amount) {
  state = { index: 0, values: [], errors: [], requests: [] };
  const render = () => {
    state.index = 0;
    return WithdrawDialog({ maxAvailable, onWithdraw: () => {} });
  };
  let tree = render();
  const input = elements(tree).find(node => node.type === "input" && node.props.id === "withdraw-amount");
  input.props.onChange({ target: { value: amount } });
  tree = render();
  state.label = text(elements(tree).find(node => node.type === "label" && node.props.htmlFor === "withdraw-amount"));
  const button = elements(tree).find(node => node.type === "button" && node.props.onClick);
  await button.props.onClick();
  return state;
}

test("a normalized loaded zero shows its maximum and blocks a positive withdrawal", async () => {
  const { available } = normalizeGatewayBalances({ available: "0.000000", withdrawing: "0", withdrawable: "0" });
  assert.equal(available, "0");
  const state = await submit(available, "0.000001");
  assert.equal(state.requests.length, 0);
  assert.equal(state.errors[0][0], "Amount exceeds balance");
  assert.match(state.label, /max: 0$/);
});

test("fractional zero retains the same immediate rejection", async () => {
  const state = await submit("0.000000", "1");
  assert.equal(state.requests.length, 0);
  assert.equal(state.errors[0][0], "Amount exceeds balance");
  assert.match(state.label, /max: 0\.000000$/);
});

test("an amount above a positive balance is rejected before fetch", async () => {
  const state = await submit("1", "2");
  assert.equal(state.requests.length, 0);
  assert.equal(state.errors[0][0], "Amount exceeds balance");
  assert.match(state.label, /max: 1$/);
});

test("an amount equal to a positive balance reaches the mocked request", async () => {
  const state = await submit("1", "1");
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0][0], "/api/gateway/withdraw");
  assert.equal(JSON.parse(state.requests[0][1].body).amount, "1");
  assert.match(state.label, /max: 1$/);
});

test("a not-yet-loaded maximum is distinct from a known zero", async () => {
  const state = await submit(null, "1");
  assert.equal(state.requests.length, 1);
  assert.doesNotMatch(state.label, /max:/);
});
