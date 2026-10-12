import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const owner = "11111111-1111-1111-1111-111111111111",
  other = "22222222-2222-2222-2222-222222222222",
  company = "44444444-4444-4444-4444-444444444444",
  app = "55555555-5555-5555-5555-555555555555",
  token = "66666666-6666-6666-6666-666666666666";
const migration = readFileSync(
  new URL("../database/005_agent.sql", import.meta.url),
  "utf8",
);
async function setup() {
  const pg = new PGlite();
  await pg.exec(
    `create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);`,
  );
  await pg.exec(
    readFileSync(new URL("./base-schema.sql", import.meta.url), "utf8").replace(
      "create extension if not exists pgcrypto;",
      "",
    ),
  );
  await pg.exec(
    readFileSync(
      new URL("../database/003_backend.sql", import.meta.url),
      "utf8",
    ),
  );
  await pg.exec(migration);
  await pg.query("insert into auth.users(id) values ($1),($2)", [owner, other]);
  await pg.query(
    "insert into companies(id,owner_id,name) values ($1,$2,'Example')",
    [company, owner],
  );
  await pg.query(
    "insert into company_applications(id,company_id,submitted_by,version,payload) values($1,$2,$3,1,'{}')",
    [app, company, owner],
  );
  return pg;
}
test("SQL trigger queues once, browser cannot claim/write, owner sees own jobs and other user cannot; migration reapplication safe", async () => {
  const pg = await setup();
  try {
    await pg.exec(migration);
    assert.equal(
      (await pg.query("select count(*)::int n from agent_jobs")).rows[0].n,
      1,
    );
    assert.equal(
      (
        await pg.query(
          "select has_function_privilege('authenticated','backend_claim_agent_job(uuid)','EXECUTE') allowed",
        )
      ).rows[0].allowed,
      false,
    );
    await pg.exec("set role authenticated");
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [
      owner,
    ]);
    assert.equal((await pg.query("select id from agent_jobs")).rows.length, 1);
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [
      other,
    ]);
    assert.equal((await pg.query("select id from agent_jobs")).rows.length, 0);
    await assert.rejects(pg.query("update agent_jobs set status='completed'"));
  } finally {
    await pg.close();
  }
});
test("lease excludes duplicate claim, completed job creates exactly one report/notification and stale completion rejected", async () => {
  const pg = await setup();
  try {
    const job = (
      await pg.query("select backend_claim_agent_job($1) job", [token])
    ).rows[0].job;
    assert.equal(job.attempts, 1);
    assert.equal(
      (await pg.query("select backend_claim_agent_job($1) job", [other]))
        .rows[0].job,
      null,
    );
    const args = [
      job.id,
      token,
      "model",
      "v2",
      "{}",
      "hash",
      JSON.stringify({ recommendation: "review_required", summary: "Review" }),
    ];
    await pg.query(
      "select backend_finish_agent_job($1,$2,$3,$4,$5,$6,$7)",
      args,
    );
    await assert.rejects(
      pg.query("select backend_finish_agent_job($1,$2,$3,$4,$5,$6,$7)", args),
      /Stale lease/,
    );
    assert.equal(
      (await pg.query("select count(*)::int n from ai_reports")).rows[0].n,
      1,
    );
    assert.equal(
      (await pg.query("select count(*)::int n from notifications")).rows[0].n,
      1,
    );
    assert.equal(
      (await pg.query("select count(*)::int n from review_decisions")).rows[0]
        .n,
      0,
    );
  } finally {
    await pg.close();
  }
});
test("newer version arriving during generation discards obsolete report; retry delayed and bounded", async () => {
  const pg = await setup();
  try {
    const job = (
      await pg.query("select backend_claim_agent_job($1) job", [token])
    ).rows[0].job;
    await pg.query(
      "insert into company_applications(company_id,submitted_by,version,payload) values($1,$2,2,'{}')",
      [company, owner],
    );
    const result = (
      await pg.query(
        "select backend_finish_agent_job($1,$2,$3,$4,$5,$6,$7) r",
        [
          job.id,
          token,
          "model",
          "v2",
          "{}",
          "hash",
          JSON.stringify({
            recommendation: "review_required",
            summary: "Review",
          }),
        ],
      )
    ).rows[0].r;
    assert.equal(result.status, "superseded");
    assert.equal((await pg.query("select * from ai_reports")).rows.length, 0);
    const next = (
      await pg.query("select backend_claim_agent_job($1) job", [other])
    ).rows[0].job;
    await pg.query("select backend_fail_agent_job($1,$2,$3,$4)", [
      next.id,
      other,
      "upstream_error",
      false,
    ]);
    assert.equal(
      (await pg.query("select backend_claim_agent_job($1) job", [token]))
        .rows[0].job,
      null,
    );
    await pg.query(
      "update agent_jobs set available_at=now(),attempts=2 where id=$1",
      [next.id],
    );
    const last = (
      await pg.query("select backend_claim_agent_job($1) job", [token])
    ).rows[0].job;
    assert.equal(last.attempts, 3);
    await pg.query("select backend_fail_agent_job($1,$2,$3,$4)", [
      next.id,
      token,
      "upstream_error",
      false,
    ]);
    assert.equal(
      (await pg.query("select status from agent_jobs where id=$1", [next.id]))
        .rows[0].status,
      "failed",
    );
  } finally {
    await pg.close();
  }
});
