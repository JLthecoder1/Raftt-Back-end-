import { randomUUID } from "node:crypto";
import { analysisInput, attachDocuments } from "./agent-input.js";
import { canonical, sha } from "./core.js";
export class AgentWorker {
  constructor(db, ai, cfg) {
    Object.assign(this, { db, ai, cfg });
    this.running = false;
    this.stopped = false;
  }
  async tick() {
    if (this.running || this.stopped || !this.ai.configured()) return;
    this.running = true;
    try {
      const token = randomUUID();
      const job = await this.db.rpc("backend_claim_agent_job", {
        p_token: token,
      });
      if (!job?.id) return;
      try {
        const context = await analysisInput(
          this.db,
          job.kind,
          job.target_id,
          job.source_id,
        );
        if (job.company_id !== context.companyId)
          throw { code: "wrong_company" };
        const attachments = await attachDocuments(
          this.db,
          context,
          this.cfg.aiProvider,
        );
        const result = await this.ai.analyze(context.input, attachments),
          text = canonical(context.input);
        await this.db.rpc("backend_finish_agent_job", {
          p_job: job.id,
          p_token: token,
          p_model: result.model,
          p_version: result.modelVersion,
          p_input: text,
          p_hash: sha(text),
          p_report: result.report,
        });
      } catch (e) {
        const code = String(e.code || "analysis_failed").slice(0, 80);
        const permanent = [
          "superseded",
          "not_found",
          "wrong_company",
          "no_evidence",
          "ai_input_too_large",
        ].includes(code);
        await this.db.rpc("backend_fail_agent_job", {
          p_job: job.id,
          p_token: token,
          p_code: code,
          p_permanent: permanent,
        });
        console.warn("RAFTT agent job failed:", job.id, code);
      }
    } finally {
      this.running = false;
    }
  }
  start() {
    if (!this.cfg.agentEnabled || !this.ai.configured()) return;
    const run = () =>
      this.tick().catch((e) =>
        console.warn("RAFTT agent queue unavailable:", e.code || "queue_error"),
      );
    run();
    this.timer = setInterval(run, this.cfg.agentPollMs);
    this.timer.unref();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }
}
