import test from "node:test";
import assert from "node:assert/strict";
import { Analyst } from "../src/ai.js";
import { AgentWorker } from "../src/agent-worker.js";
import { attachDocuments } from "../src/agent-input.js";
const report = {
  recommendation: "review_required",
  summary: "Conteúdo declarado",
  risks: [],
  missing_information: ["Comprovação de clientes"],
  milestone_assessment: "A declaração não prova o critério",
};
test("Gemini receives server key, structured schema and private document bytes; model output cannot authorize money", async () => {
  let request;
  const ai = new Analyst(
    { aiProvider: "gemini", geminiKey: "private-key", model: "model-test" },
    {
      fetchJSON: async (url, options) => {
        request = { url, options };
        return {
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: JSON.stringify(report) }] },
            },
          ],
          usageMetadata: { totalTokenCount: 20 },
        };
      },
    },
  );
  const result = await ai.analyze({ kind: "application", language: "en" }, [
    {
      id: "doc",
      name: "Pitch",
      bytes: Buffer.from("%PDF-test"),
      mimeType: "application/pdf",
      hash: "hash",
    },
  ]);
  assert.equal(request.options.headers["x-goog-api-key"], "private-key");
  assert(!request.url.includes("private-key"));
  const body = JSON.parse(request.options.body);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(
    body.contents[0].parts[2].inlineData.mimeType,
    "application/pdf",
  );
  assert(!body.tools);
  assert.equal(result.report.processing.documents_read[0].id, "doc");
  assert.equal(result.modelVersion, "raftt-analyst-v2");
});
test("invalid, truncated and unauthorized approval output fail closed; no fabricated report when key missing", async () => {
  for (const output of [
    { ...report, recommendation: "approved" },
    { ...report, tool: "transfer" },
    { ...report, risks: [123] },
  ]) {
    const ai = new Analyst(
      { aiProvider: "gemini", geminiKey: "x", model: "test" },
      {
        fetchJSON: async () => ({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: JSON.stringify(output) }] },
            },
          ],
        }),
      },
    );
    await assert.rejects(ai.analyze({}), (e) => e.code === "ai_invalid");
  }
  await assert.rejects(
    new Analyst({}).analyze({}),
    (e) => e.code === "ai_unconfigured",
  );
  const ai = new Analyst(
    { aiProvider: "gemini", geminiKey: "x", model: "test" },
    {
      fetchJSON: async () => ({ candidates: [{ finishReason: "MAX_TOKENS" }] }),
    },
  );
  await assert.rejects(ai.analyze({}), (e) => e.code === "ai_incomplete");
});
test("documents skipped for size/type are explicit; storage outages retry rather than becoming evidence", async () => {
  const context = { documents: [{ id: "doc" }], input: { limitations: [] } };
  await attachDocuments(
    {
      documentBytes: async () => {
        throw { code: "unsupported_document" };
      },
    },
    context,
    "gemini",
  );
  assert.match(context.input.limitations[0], /não lido/);
  await assert.rejects(
    attachDocuments(
      {
        documentBytes: async () => {
          throw { code: "document_unavailable" };
        },
      },
      context,
      "gemini",
    ),
  );
});
test("worker claims atomically, refuses superseded inputs and leaves decisions untouched", async () => {
  const calls = [];
  let claimed = false;
  const db = {
    rpc: async (name, data) => {
      calls.push({ name, data });
      if (name === "backend_claim_agent_job") {
        if (claimed) return null;
        claimed = true;
        return {
          id: "job",
          kind: "application",
          target_id: "old",
          source_id: "old",
          company_id: "company",
        };
      }
    },
    one: async (table, filter) =>
      filter.id
        ? { id: "old", company_id: "company", payload: {} }
        : { id: "new" },
  };
  const worker = new AgentWorker(
    db,
    {
      configured: () => true,
      analyze: async () => {
        throw Error("must not run");
      },
    },
    { aiProvider: "gemini" },
  );
  await worker.tick();
  assert.equal(calls[1].name, "backend_fail_agent_job");
  assert.equal(calls[1].data.p_code, "superseded");
  assert.equal(calls[1].data.p_permanent, true);
  assert(!calls.some((c) => c.name.includes("decide")));
});
test("worker saves canonical source and report via one fenced completion; overlapping ticks do not issue two requests", async () => {
  let resolve;
  const ready = new Promise((r) => {
    resolve = r;
  });
  const calls = [];
  const db = {
    rpc: async (name, data) => {
      calls.push({ name, data });
      if (name === "backend_claim_agent_job")
        return {
          id: "job",
          kind: "application",
          target_id: "app",
          source_id: "app",
          company_id: "company",
        };
      return { status: "completed" };
    },
    one: async () => ({
      id: "app",
      company_id: "company",
      version: 1,
      payload: { documentIds: [] },
    }),
    rest: async () => [],
  };
  const ai = {
    configured: () => true,
    analyze: async () => {
      await ready;
      return { model: "test", modelVersion: "v2", report };
    },
  };
  const worker = new AgentWorker(db, ai, { aiProvider: "gemini" });
  const first = worker.tick();
  await worker.tick();
  resolve();
  await first;
  assert.equal(
    calls.filter((c) => c.name === "backend_claim_agent_job").length,
    1,
  );
  assert.equal(calls.at(-1).name, "backend_finish_agent_job");
  assert.equal(JSON.parse(calls.at(-1).data.p_input).applicationId, "app");
  assert.equal(calls[0].data.p_token, calls.at(-1).data.p_token);
});
