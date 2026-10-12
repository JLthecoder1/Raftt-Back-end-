import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const alice = "11111111-1111-1111-1111-111111111111",
  bob = "22222222-2222-2222-2222-222222222222",
  reviewer = "33333333-3333-3333-3333-333333333333",
  company = "44444444-4444-4444-4444-444444444444",
  app = "55555555-5555-5555-5555-555555555555",
  wallet = "66666666-6666-6666-6666-666666666666",
  round = "77777777-7777-7777-7777-777777777777";
async function database() {
  const pg = new PGlite();
  await pg.exec(
    `create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);`,
  );
  const base = readFileSync(
    new URL("./base-schema.sql", import.meta.url),
    "utf8",
  ).replace("create extension if not exists pgcrypto;", "");
  await pg.exec(base);
  await pg.exec(
    readFileSync(
      new URL("../database/003_backend.sql", import.meta.url),
      "utf8",
    ),
  );
  await pg.query("insert into auth.users(id) values ($1),($2),($3)", [
    alice,
    bob,
    reviewer,
  ]);
  await pg.query(
    "insert into public.companies(id,owner_id,name) values ($1,$2,$3)",
    [company, alice, "Company"],
  );
  return pg;
}
test("migration executes in embedded PostgreSQL and private RPCs are denied to browser roles", async () => {
  const pg = await database();
  try {
    const r = await pg.query(
      "select has_function_privilege('authenticated','public.backend_verify_wallet(uuid,uuid,text)','EXECUTE') as allowed",
    );
    assert.equal(r.rows[0].allowed, false);
    const s = await pg.query(
      "select has_table_privilege('authenticated','public.backend_wallet_challenges','SELECT') as allowed",
    );
    assert.equal(s.rows[0].allowed, false);
    await pg.exec(
      readFileSync(
        new URL("../database/003_backend.sql", import.meta.url),
        "utf8",
      ),
    );
  } finally {
    await pg.close();
  }
});
test("wallet proof consuming RPC rejects replay and another-account claims atomically", async () => {
  const pg = await database();
  try {
    const a = await pg.query(
      "insert into public.backend_wallet_challenges(user_id,address,message,expires_at) values ($1,'wallet','message',now()+interval '5 minutes') returning id",
      [alice],
    );
    const id = a.rows[0].id;
    await pg.query("select public.backend_verify_wallet($1,$2,$3)", [
      id,
      alice,
      "wallet",
    ]);
    await assert.rejects(
      pg.query("select public.backend_verify_wallet($1,$2,$3)", [
        id,
        alice,
        "wallet",
      ]),
      /already used/,
    );
    const b = await pg.query(
      "insert into public.backend_wallet_challenges(user_id,address,message,expires_at) values ($1,'wallet','message',now()+interval '5 minutes') returning id",
      [bob],
    );
    await assert.rejects(
      pg.query("select public.backend_verify_wallet($1,$2,$3)", [
        b.rows[0].id,
        bob,
        "wallet",
      ]),
      /another account/,
    );
    const r = await pg.query(
      "select consumed_at from public.backend_wallet_challenges where id=$1",
      [b.rows[0].id],
    );
    assert.equal(r.rows[0].consumed_at, null);
  } finally {
    await pg.close();
  }
});
test("application decisions require staff and current version; a repeated decision is rejected", async () => {
  const pg = await database();
  try {
    await pg.query(
      "insert into public.company_applications(id,company_id,submitted_by,version,payload) values ($1,$2,$3,1,$4)",
      [app, company, alice, "{}"],
    );
    await assert.rejects(
      pg.query(
        "select public.backend_decide_application($1,$2,$3,$4,null,$5,$6)",
        [app, alice, "approved", "ok", "hash", "document"],
      ),
      /Reviewer/,
    );
    await pg.query("insert into public.platform_staff values ($1,'reviewer')", [
      reviewer,
    ]);
    await pg.query(
      "select public.backend_decide_application($1,$2,$3,$4,null,$5,$6)",
      [app, reviewer, "approved", "ok", "hash", "document"],
    );
    await assert.rejects(
      pg.query(
        "select public.backend_decide_application($1,$2,$3,$4,null,$5,$6)",
        [app, reviewer, "approved", "ok", "hash", "document"],
      ),
      /already decided/,
    );
    assert.equal(
      (await pg.query("select count(*) as n from public.notifications")).rows[0]
        .n,
      1,
    );
  } finally {
    await pg.close();
  }
});
test("position sync keeps newest chain slot and exact principal", async () => {
  const pg = await database();
  try {
    await pg.query(
      "insert into public.wallets(id,user_id,address,verified_at) values ($1,$2,$3,now())",
      [wallet, alice, "wallet"],
    );
    await pg.query(
      "insert into public.rounds(id,company_id,instrument,network,program_id,chain_address,mint,decimals,minimum_units,cap_units,deadline,recipient) values ($1,$2,'safe','devnet','program','round','mint',6,1,100,now(),'recipient')",
      [round, company],
    );
    await pg.query("select public.backend_sync_position($1,$2,$3,$4,$5,$6)", [
      alice,
      round,
      wallet,
      "position",
      "9007199254740993",
      20,
    ]);
    await pg.query("select public.backend_sync_position($1,$2,$3,$4,$5,$6)", [
      alice,
      round,
      wallet,
      "position",
      "1",
      19,
    ]);
    const r = await pg.query(
      "select principal_units::text as amount,chain_slot from public.investments",
    );
    assert.equal(r.rows[0].amount, "9007199254740993");
    assert.equal(r.rows[0].chain_slot, 20);
  } finally {
    await pg.close();
  }
});
test("round registration commits verified link and transaction together and is idempotent", async () => {
  const pg = await database();
  try {
    await pg.query(
      "insert into public.company_applications(id,company_id,submitted_by,version,payload,status) values ($1,$2,$3,1,'{}','approved')",
      [app, company, alice],
    );
    await pg.query(
      "insert into public.wallets(id,user_id,address,verified_at) values ($1,$2,$3,now())",
      [wallet, alice, "creator"],
    );
    const params = {
      creator: "creator",
      mint: "mint",
      plan_hash: "hash",
      minimum: "10",
      cap: "20",
      round_id: "1",
      deadline: "2000000000",
      recipient: "recipient",
      instrument: "safe",
      network: "devnet",
      program_id: "program",
      round_address: "address",
      decimals: 6,
      terms: {},
    };
    const draft = await pg.query(
      "insert into public.backend_round_drafts(company_id,application_id,user_id,wallet_id,params,plan_document,expires_at) values ($1,$2,$3,$4,$5,'document',now()+interval '5 minutes') returning id",
      [company, app, alice, wallet, JSON.stringify(params)],
    );
    const s = { ...params, chain_status: "draft", raised: "0", released: "0" };
    const args = [
      draft.rows[0].id,
      alice,
      "signature",
      JSON.stringify(s),
      30,
      null,
    ];
    const first = await pg.query(
      "select public.backend_register_round($1,$2,$3,$4,$5,$6) as id",
      args,
    );
    const second = await pg.query(
      "select public.backend_register_round($1,$2,$3,$4,$5,$6) as id",
      args,
    );
    assert.equal(first.rows[0].id, second.rows[0].id);
    assert.equal(
      (await pg.query("select count(*) as n from public.chain_transactions"))
        .rows[0].n,
      1,
    );
    const mismatch = await pg.query(
      "insert into public.backend_round_drafts(company_id,application_id,user_id,wallet_id,params,plan_document,expires_at) values ($1,$2,$3,$4,$5,'document',now()+interval '5 minutes') returning id",
      [company, app, alice, wallet, JSON.stringify(params)],
    );
    await assert.rejects(
      pg.query("select public.backend_register_round($1,$2,$3,$4,$5,$6)", [
        mismatch.rows[0].id,
        alice,
        "other",
        JSON.stringify({ ...s, mint: null }),
        31,
        null,
      ]),
      /Snapshot mismatch/,
    );
  } finally {
    await pg.close();
  }
});
