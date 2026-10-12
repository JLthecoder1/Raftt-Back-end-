import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import {
  canonical,
  sha,
  verifyWallet,
  walletMessage,
  u64,
  JSONbig,
} from "../src/core.js";
test("u64 and JSON preserve integers above Number.MAX_SAFE_INTEGER", () => {
  assert.equal(u64("18446744073709551615"), "18446744073709551615");
  assert.throws(() => u64(12));
  assert.throws(() => u64("18446744073709551616"));
  assert.equal(
    JSONbig.parse('{"amount":18446744073709551615}').amount,
    "18446744073709551615",
  );
});
test("canonical hashes ignore object insertion order but detect changed terms", () => {
  assert.equal(
    sha(canonical({ a: 1, b: { x: "2" } })),
    sha(canonical({ b: { x: "2" }, a: 1 })),
  );
  assert.notEqual(
    sha(canonical({ amount: "10" })),
    sha(canonical({ amount: "11" })),
  );
});
test("actual Ed25519 signatures bind wallet, exact message and user", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const wallet = bs58.encode(
    publicKey.export({ format: "der", type: "spki" }).subarray(-32),
  );
  const message = walletMessage({
    userId: "alice",
    wallet,
    nonce: "random",
    origin: "http://localhost:8765",
    expiresAt: "2026-01-01",
  });
  const signature = sign(null, Buffer.from(message), privateKey).toString(
    "base64",
  );
  assert.equal(verifyWallet(wallet, message, signature), true);
  assert.equal(
    verifyWallet(wallet, message.replace("alice", "bob"), signature),
    false,
  );
  assert.equal(verifyWallet(wallet, message + " ", signature), false);
  assert.equal(verifyWallet(wallet, message, "bad"), false);
});
