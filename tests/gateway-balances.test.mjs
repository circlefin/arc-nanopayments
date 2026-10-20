import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeGatewayBalances } from "../lib/gateway-balances.ts";

test("whole decimal amounts have the same units as fractional strings", () => {
  for (const available of ["1", "1.0", "1.000000"]) {
    assert.deepEqual(
      normalizeGatewayBalances({
        available,
        withdrawing: "2",
        withdrawable: "1",
      }),
      { total: "3.000000", available: "1", withdrawing: "2", withdrawable: "1" },
    );
  }
});

test("zero and one atomic unit remain distinct", () => {
  assert.deepEqual(
    normalizeGatewayBalances({
      available: "0",
      withdrawing: "0",
      withdrawable: "0",
    }),
    { total: "0.000000", available: "0", withdrawing: "0", withdrawable: "0" },
  );
  assert.deepEqual(
    normalizeGatewayBalances({
      available: "0.000001",
      withdrawing: "0",
      withdrawable: "0.000001",
    }),
    { total: "0.000001", available: "0.000001", withdrawing: "0", withdrawable: "0.000001" },
  );
});

test("ordinary decimals normalize while total keeps six fractional digits", () => {
  assert.deepEqual(
    normalizeGatewayBalances({
      available: "1.5",
      withdrawing: "0.5",
      withdrawable: "1.0",
    }),
    { total: "2.000000", available: "1.5", withdrawing: "0.5", withdrawable: "1" },
  );
});

test("totals preserve atomic units beyond Number's exact integer range", () => {
  assert.deepEqual(
    normalizeGatewayBalances({
      available: "9007199254.740993",
      withdrawing: "0.000001",
      withdrawable: "0",
    }),
    {
      total: "9007199254.740994",
      available: "9007199254.740993",
      withdrawing: "0.000001",
      withdrawable: "0",
    },
  );
});

test("adding fractions carries into the whole amount exactly", () => {
  assert.equal(
    normalizeGatewayBalances({
      available: "0.999999",
      withdrawing: "0.000001",
      withdrawable: "0",
    }).total,
    "1.000000",
  );
});

test("redundant leading and trailing zeros preserve value", () => {
  assert.deepEqual(
    normalizeGatewayBalances({
      available: "0001.2300000",
      withdrawing: "0002",
      withdrawable: "0.0000000",
    }),
    { total: "3.230000", available: "1.23", withdrawing: "2", withdrawable: "0" },
  );
});

test("invalid or inexact amounts fail instead of being rounded or guessed", () => {
  for (const invalid of [
    "", " ", "1\n", "1e6", "-1", "+1", "NaN", "Infinity",
    ".5", "1.", "1,000", "0.0000001", "1.0000001",
  ]) {
    for (const field of ["available", "withdrawing", "withdrawable"]) {
      assert.throws(
        () => normalizeGatewayBalances({
          available: "0",
          withdrawing: "0",
          withdrawable: "0",
          [field]: invalid,
        }),
        undefined,
        `${field}: ${invalid}`,
      );
    }
  }
});
