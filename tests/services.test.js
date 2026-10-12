import test from "node:test";
import assert from "node:assert/strict";
import { Services } from "../src/services.js";
import { ApiError } from "../src/core.js";
const uuid = "11111111-1111-1111-1111-111111111111",
  user = { id: "alice" };
test("AI analysis requires staff before reading private candidature", async () => {
  let read = false;
  const db = {
    staff: async () => {
      throw new ApiError(403, "staff_required", "Equipe necessária");
    },
    one: async () => {
      read = true;
    },
  };
  await assert.rejects(
    new Services(db, {}, {}, {}).analyzeApplication(user, uuid),
    /Equipe/,
  );
  assert.equal(read, false);
});
test("wallet signature must match the stored challenge; expired challenge never invokes consuming RPC", async () => {
  let consumed = false;
  const db = {
    one: async () => ({
      id: uuid,
      expires_at: "2000-01-01",
      consumed_at: null,
    }),
    rpc: async () => {
      consumed = true;
    },
  };
  await assert.rejects(
    new Services(db, {}, {}, {}).verify(user, {
      challengeId: uuid,
      signature: "bad",
    }),
    /expirado/,
  );
  assert.equal(consumed, false);
});
test("round preparation refuses unapproved application before accessing wallets or chain", async () => {
  const db = {
    one: async () => ({ id: uuid, company_id: uuid, status: "submitted" }),
    company: async () => ({ owner_id: "alice" }),
  };
  await assert.rejects(
    new Services(db, {}, {}, {}).prepareRound(user, { applicationId: uuid }),
    /aprovada/,
  );
});
test("register refuses finalized creation whose immutable values differ from prepared draft", async () => {
  const params = {
    creator: "creator",
    round_address: "round",
    mint: "mint",
    round_id: "1",
    minimum: "10",
    cap: "20",
    deadline: "999",
    recipient: "recipient",
    plan_hash: "hash",
  };
  let registered = false;
  const db = {
    one: async () => ({
      id: uuid,
      company_id: uuid,
      params,
      instruction_data: "bytes",
      expires_at: "2099-01-01",
    }),
    company: async () => ({}),
    rpc: async () => {
      registered = true;
    },
  };
  const chain = {
    transaction: async () => ({ slot: 1 }),
    account: async () => ({ slot: 2, state: { ...params, cap: "21" } }),
  };
  await assert.rejects(
    new Services(db, chain, {}, {}).registerRound(user, {
      draftId: uuid,
      signature: "signature",
    }),
    /não corresponde/,
  );
  assert.equal(registered, false);
});
test("financial sync sends snapshot slot to prevent stale cache updates", async () => {
  let captured;
  const db = {
    update: async (_table, filters) => {
      captured = filters;
    },
    rest: async () => [],
  };
  const chain = {
    snapshot: async () => ({
      slot: 42,
      state: {
        mint: "mint",
        plan_hash: "hash",
        status: 1,
        raised: "9007199254740993",
        released: "0",
      },
    }),
  };
  await new Services(db, chain, {}, {}).sync({
    id: uuid,
    chain_address: "round",
    mint: "mint",
    plan_hash: "hash",
  });
  assert.equal(captured.chain_slot, "lte.42");
});
