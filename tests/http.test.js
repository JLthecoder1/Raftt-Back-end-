import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { ApiError } from "../src/core.js";
const cfg = {
  network: "devnet",
  programId: "program",
  origins: ["http://localhost:8765"],
};
async function withServer(fn) {
  const db = {
    authenticate: async (token) => {
      if (token !== "valid")
        throw new ApiError(401, "unauthorized", "Sessão inválida.");
      return { id: "alice", email: "alice@example.com" };
    },
    rest: async (_t, p) => p,
  };
  const server = createServer(createApp({ db, chain: {}, services: {}, cfg }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn("http://127.0.0.1:" + server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
test("health is public; all account endpoints require validated JWT", async () =>
  withServer(async (url) => {
    assert.equal((await fetch(url + "/health")).status, 200);
    assert.equal((await fetch(url + "/v1/me")).status, 401);
    const r = await fetch(url + "/v1/me", {
      headers: { Authorization: "Bearer valid" },
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).data.id, "alice");
  }));
test("CORS denies unknown origins and handles allowed preflight", async () =>
  withServer(async (url) => {
    assert.equal(
      (
        await fetch(url + "/health", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const r = await fetch(url + "/v1/me", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:8765" },
    });
    assert.equal(r.status, 204);
    assert.equal(
      r.headers.get("Access-Control-Allow-Origin"),
      "http://localhost:8765",
    );
  }));
test("wallet listing is scoped to authenticated user, not body/query claims", async () =>
  withServer(async (url) => {
    const r = await fetch(url + "/v1/wallets?user_id=bob", {
      headers: { Authorization: "Bearer valid" },
    });
    assert.equal((await r.json()).data.user_id, "eq.alice");
  }));
test("private sync job fails closed without configured secret", async () =>
  withServer(async (url) => {
    assert.equal(
      (
        await fetch(url + "/jobs/sync", {
          method: "POST",
          headers: { Authorization: "Bearer valid" },
        })
      ).status,
      401,
    );
  }));
