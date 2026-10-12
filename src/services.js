import { analysisInput, attachDocuments } from "./agent-input.js";
import { randomUUID, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  uuid,
  address,
  u64,
  required,
  canonical,
  sha,
  walletMessage,
  nonce,
  verifyWallet,
  fail,
} from "./core.js";
const states = ["draft", "open", "successful", "failed"];
export class Services {
  constructor(db, chain, ai, cfg) {
    Object.assign(this, { db, chain, ai, cfg });
  }
  async challenge(user, body, origin) {
    const wallet = address(body.address),
      expiresAt = new Date(Date.now() + 300000).toISOString();
    const message = walletMessage({
      userId: user.id,
      wallet,
      nonce: nonce(),
      expiresAt,
      origin: origin || this.cfg.origins[0],
    });
    const [row] = await this.db.insert("backend_wallet_challenges", {
      user_id: user.id,
      address: wallet,
      message,
      expires_at: expiresAt,
    });
    return { id: row.id, message, expiresAt };
  }
  async verify(user, body) {
    const c = await this.db.one("backend_wallet_challenges", {
      id: `eq.${uuid(body.challengeId)}`,
      user_id: `eq.${user.id}`,
    });
    if (c.consumed_at || Date.parse(c.expires_at) <= Date.now())
      fail(409, "challenge_expired", "Desafio expirado ou utilizado.");
    if (!verifyWallet(c.address, c.message, body.signature))
      fail(422, "invalid_wallet_signature", "Assinatura da carteira inválida.");
    return this.db.rpc("backend_verify_wallet", {
      p_challenge: c.id,
      p_user: user.id,
      p_wallet: c.address,
    });
  }
  async application(user, id) {
    const app = await this.db.one("company_applications", {
      id: `eq.${uuid(id)}`,
    });
    await this.db.company(user, app.company_id);
    return app;
  }
  async analyzeApplication(user, id) {
    await this.db.staff(user);
    const app = await this.application(user, id);
    return this.saveContextAnalysis(
      await analysisInput(this.db, "application", app.id),
    );
  }
  async saveContextAnalysis(context) {
    const attachments = await attachDocuments(
      this.db,
      context,
      this.cfg.aiProvider,
    );
    return this.saveAnalysis(
      context.companyId,
      context.applicationId,
      context.milestoneId,
      context.input,
      attachments,
    );
  }
  async saveAnalysis(
    companyId,
    applicationId,
    milestoneId,
    input,
    attachments = [],
  ) {
    const text = canonical(input),
      result = await this.ai.analyze(input, attachments);
    const [row] = await this.db.insert("ai_reports", {
      company_id: companyId,
      application_id: applicationId,
      milestone_id: milestoneId,
      model: result.model,
      model_version: result.modelVersion,
      input_hash: sha(text),
      canonical_input: text,
      report: result.report,
    });
    return row;
  }
  async decideApplication(user, id, body) {
    await this.db.staff(user);
    const app = await this.application(user, id);
    if (!["approved", "rejected", "changes_requested"].includes(body.decision))
      fail(400, "invalid_decision", "Decisão inválida.");
    const reason = required(body.reason, "Motivo", 5000),
      reportId = body.reportId ? uuid(body.reportId) : null;
    if (reportId) {
      const report = await this.db.one("ai_reports", { id: `eq.${reportId}` });
      if (
        report.application_id !== app.id ||
        report.company_id !== app.company_id
      )
        fail(422, "wrong_report", "Relatório não pertence à candidatura.");
    }
    const document = canonical({
      applicationId: app.id,
      version: app.version,
      reviewerId: user.id,
      decision: body.decision,
      reason,
      reportId,
    });
    const hash = sha(document);
    const idResult = await this.db.rpc("backend_decide_application", {
      p_application: app.id,
      p_reviewer: user.id,
      p_decision: body.decision,
      p_reason: reason,
      p_report: reportId,
      p_hash: hash,
      p_document: document,
    });
    return {
      id: idResult,
      reviewHash: hash,
      document,
      chainAuthorization: false,
    };
  }
  async prepareRound(user, body) {
    const applicationId = uuid(body.applicationId),
      app = await this.application(user, applicationId);
    await this.db.company(user, app.company_id, { owner: true });
    const latest = await this.db.one("company_applications", {
      company_id: `eq.${app.company_id}`,
      order: "version.desc",
    });
    if (latest.id !== app.id || app.status !== "approved")
      fail(
        409,
        "approval_required",
        "A candidatura atual precisa estar aprovada pela RAFTT.",
      );
    const wallet = await this.db.one("wallets", {
      id: `eq.${uuid(body.walletId)}`,
      user_id: `eq.${user.id}`,
    });
    const minimum = u64(body.minimumUnits),
      cap = u64(body.capUnits),
      roundId = body.roundId
        ? u64(body.roundId)
        : randomBytes(8).readBigUInt64LE().toString();
    if (BigInt(minimum) === 0n || BigInt(cap) < BigInt(minimum))
      fail(400, "invalid_budget", "Mínimo e limite inválidos.");
    const seconds = Math.floor(Date.parse(body.deadline) / 1000);
    if (
      !Number.isSafeInteger(seconds) ||
      seconds <= Math.floor(Date.now() / 1000) + 172800
    )
      fail(400, "invalid_deadline", "Prazo precisa estar a mais de 48 horas.");
    const mint = address(body.mint),
      recipient = address(body.recipient),
      info = await this.chain.mint(mint);
    if (!["equity", "safe", "convertible"].includes(body.instrument))
      fail(400, "invalid_instrument", "Instrumento inválido.");
    if (
      !body.terms ||
      typeof body.terms !== "object" ||
      Array.isArray(body.terms)
    )
      fail(400, "invalid_terms", "Informe os termos da rodada.");
    const plan = canonical({
      applicationId,
      applicationVersion: app.version,
      application: app.payload,
      minimumUnits: minimum,
      capUnits: cap,
      deadline: seconds,
      mint,
      recipient,
      instrument: body.instrument,
      terms: body.terms,
    });
    const params = {
      creator: wallet.address,
      round_id: roundId,
      minimum,
      cap,
      deadline: String(seconds),
      mint,
      recipient,
      plan_hash: sha(plan),
    };
    const prepared = await this.chain.createRound(params);
    const [draft] = await this.db.insert("backend_round_drafts", {
      company_id: app.company_id,
      application_id: app.id,
      user_id: user.id,
      wallet_id: wallet.id,
      params: {
        ...params,
        round_address: prepared.round_address,
        decimals: info.decimals,
        instrument: body.instrument,
        terms: body.terms,
        network: this.cfg.network,
        program_id: this.cfg.programId,
      },
      plan_document: plan,
      instruction_data: prepared.instruction_data,
      expires_at: new Date(Date.now() + 1800000).toISOString(),
    });
    return {
      draftId: draft.id,
      ...prepared,
      planDocument: plan,
      planHash: params.plan_hash,
      signer: wallet.address,
    };
  }
  async registerRound(user, body) {
    const draft = await this.db.one("backend_round_drafts", {
      id: `eq.${uuid(body.draftId)}`,
      user_id: `eq.${user.id}`,
    });
    await this.db.company(user, draft.company_id, { owner: true });
    if (draft.registered_round_id)
      return this.db.one("rounds", { id: `eq.${draft.registered_round_id}` });
    if (Date.parse(draft.expires_at) <= Date.now())
      fail(409, "draft_expired", "Rascunho de transação expirado.");
    const tx = await this.chain.transaction(
      body.signature,
      "create_round",
      {
        creator: draft.params.creator,
        round: draft.params.round_address,
        mint: draft.params.mint,
      },
      draft.instruction_data,
    );
    const snapshot = await this.chain.account(
      draft.params.round_address,
      "Round",
      tx.slot,
    );
    const state = snapshot.state;
    for (const key of [
      "creator",
      "round_id",
      "minimum",
      "cap",
      "deadline",
      "mint",
      "recipient",
      "plan_hash",
    ])
      if (String(state[key]) !== String(draft.params[key]))
        fail(
          422,
          "round_mismatch",
          "Rodada não corresponde ao plano preparado.",
        );
    if (
      this.chain.round(state.creator, state.round_id) !==
      draft.params.round_address
    )
      fail(422, "wrong_pda", "PDA inválida.");
    if (!states[state.status]) fail(422, "wrong_state", "Estado desconhecido.");
    const id = await this.db.rpc("backend_register_round", {
      p_draft: draft.id,
      p_user: user.id,
      p_signature: body.signature,
      p_snapshot: { ...state, chain_status: states[state.status] },
      p_slot: snapshot.slot,
      p_time: tx.chain_time,
    });
    return this.db.one("rounds", { id: `eq.${id}` });
  }
  async round(user, id) {
    const r = await this.db.one("rounds", { id: `eq.${uuid(id)}` });
    try {
      await this.db.company(user, r.company_id, { publicRead: true });
    } catch (e) {
      if (e.status !== 403) throw e;
      const positions = await this.db.rest("investments", {
        user_id: `eq.${user.id}`,
        round_id: `eq.${r.id}`,
        limit: 1,
      });
      if (!positions.length) throw e;
    }
    if (r.network !== this.cfg.network || r.program_id !== this.cfg.programId)
      fail(409, "wrong_network", "Rodada pertence a outro ambiente.");
    return r;
  }
  async syncRound(user, id) {
    const r = await this.round(user, id);
    return this.sync(r);
  }
  async sync(r) {
    const data = await this.chain.snapshot(r.chain_address),
      s = data.state;
    if (!states[s.status]) fail(422, "wrong_state", "Estado desconhecido.");
    if (s.mint !== r.mint || s.plan_hash !== r.plan_hash)
      fail(422, "round_mismatch", "Mint ou plano diferente do cadastro.");
    await this.db.update(
      "rounds",
      { id: `eq.${r.id}`, chain_slot: `lte.${data.slot}` },
      {
        chain_status: states[s.status],
        raised_units: s.raised,
        released_units: s.released,
        chain_slot: data.slot,
        synced_at: new Date().toISOString(),
      },
    );
    const milestones = await this.db.rest("milestones", {
      round_id: `eq.${r.id}`,
      limit: 1000,
    });
    for (const m of milestones) {
      if (m.sequence >= s.milestone_count) continue;
      const onchain = await this.chain.account(
        this.chain.milestone(r.chain_address, m.sequence),
        "Milestone",
        data.slot,
      );
      if (
        onchain.state.round !== r.chain_address ||
        onchain.state.plan_hash !== m.plan_hash ||
        onchain.state.amount !== String(m.amount_units)
      )
        fail(
          422,
          "milestone_mismatch",
          "Parcela ou plano diferente do cadastro.",
        );
      await this.db.update(
        "milestones",
        { id: `eq.${m.id}`, chain_slot: `lte.${onchain.slot}` },
        {
          chain_status: ["planned", "submitted", "authorized", "paid"][
            onchain.state.status
          ],
          chain_slot: onchain.slot,
        },
      );
    }
    return { roundId: r.id, ...data };
  }
  async syncPositions(user, id) {
    const r = await this.round(user, id),
      wallets = await this.db.rest("wallets", {
        user_id: `eq.${user.id}`,
        limit: 100,
      });
    const positions = [];
    for (const w of wallets) {
      const pda = this.chain.position(r.chain_address, w.address);
      let data;
      try {
        data = await this.chain.account(pda, "RoundPosition");
      } catch (e) {
        if (e.code === "chain_account_missing") continue;
        throw e;
      }
      if (
        data.state.round !== r.chain_address ||
        data.state.investor !== w.address
      )
        fail(422, "position_mismatch", "Posição inválida.");
      const item = await this.db.rpc("backend_sync_position", {
        p_user: user.id,
        p_round: r.id,
        p_wallet: w.id,
        p_position: pda,
        p_amount: data.state.amount,
        p_slot: data.slot,
      });
      positions.push(item);
    }
    return positions;
  }
  async milestoneContext(user, id) {
    const m = await this.db.one("milestones", { id: `eq.${uuid(id)}` }),
      r = await this.round(user, m.round_id);
    return { m, r };
  }
  async recordMilestone(user, id, body) {
    const r = await this.round(user, id);
    await this.db.company(user, r.company_id, { owner: true });
    const sequence = body.sequence;
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 65535)
      fail(400, "invalid_sequence", "Índice inválido.");
    const amount = u64(body.amountUnits);
    if (amount === "0") fail(400, "invalid_amount", "Valor deve ser positivo.");
    const document = canonical({
      roundId: r.id,
      sequence,
      title: required(body.title, "Título", 200),
      description: required(body.description, "Descrição", 5000),
      acceptanceCriteria: required(body.acceptanceCriteria, "Critérios", 5000),
      useOfFunds: required(body.useOfFunds, "Uso dos recursos", 5000),
      amountUnits: amount,
    });
    const planHash = sha(document);
    if (!body.signature) {
      const s = (await this.chain.account(r.chain_address, "Round")).state;
      const wallet = await this.db.one("wallets", {
        user_id: `eq.${user.id}`,
        address: `eq.${s.creator}`,
      });
      const unsigned = await this.chain.unsigned(
        "add_milestone",
        {
          creator: wallet.address,
          round: r.chain_address,
          milestone: this.chain.milestone(r.chain_address, sequence),
          system_program: "11111111111111111111111111111111",
        },
        { index: sequence, amount, plan_hash: planHash },
        wallet.address,
      );
      return { ...unsigned, planDocument: document, planHash };
    }
    const expected = this.chain.milestone(r.chain_address, sequence),
      state = (await this.chain.account(expected, "Milestone")).state;
    const creator = (await this.chain.account(r.chain_address, "Round")).state
      .creator;
    await this.db.one("wallets", {
      user_id: `eq.${user.id}`,
      address: `eq.${creator}`,
    });
    await this.chain.transaction(body.signature, "add_milestone", {
      creator,
      round: r.chain_address,
      milestone: expected,
    });
    if (
      state.round !== r.chain_address ||
      state.index !== sequence ||
      state.amount !== amount ||
      state.plan_hash !== planHash
    )
      fail(
        422,
        "milestone_mismatch",
        "Parcela não corresponde ao documento informado.",
      );
    const existing = await this.db.rest("milestones", {
      round_id: `eq.${r.id}`,
      sequence: `eq.${sequence}`,
    });
    if (existing.length) {
      if (existing[0].plan_hash !== planHash)
        fail(409, "immutable_plan", "Plano já registrado.");
      return existing[0];
    }
    const [m] = await this.db.insert("milestones", {
      round_id: r.id,
      sequence,
      title: body.title,
      description: body.description,
      acceptance_criteria: body.acceptanceCriteria,
      use_of_funds: body.useOfFunds,
      amount_units: amount,
      plan_hash: planHash,
      plan_document: document,
      chain_status: ["planned", "submitted", "authorized", "paid"][
        state.status
      ],
    });
    return m;
  }
  async evidence(user, id, body) {
    const { m, r } = await this.milestoneContext(user, id);
    await this.db.company(user, r.company_id, { owner: true });
    const description = required(body.description, "Evidências", 20000),
      documentId = body.documentId ? uuid(body.documentId) : null;
    if (documentId) {
      const doc = await this.db.one("documents", { id: `eq.${documentId}` });
      if (doc.company_id !== r.company_id)
        fail(422, "wrong_document", "Documento pertence a outra empresa.");
    }
    const document = canonical({ milestoneId: m.id, description, documentId });
    const [e] = await this.db.insert("evidence", {
      milestone_id: m.id,
      submitted_by: user.id,
      description,
      document_id: documentId,
      evidence_hash: sha(document),
      canonical_document: document,
    });
    return e;
  }
  async prepareEvidence(user, id, evidenceId) {
    const { m, r } = await this.milestoneContext(user, id);
    await this.db.company(user, r.company_id, { owner: true });
    const e = await this.db.one("evidence", {
        id: `eq.${uuid(evidenceId)}`,
        milestone_id: `eq.${m.id}`,
      }),
      s = (await this.chain.account(r.chain_address, "Round")).state;
    await this.db.one("wallets", {
      user_id: `eq.${user.id}`,
      address: `eq.${s.creator}`,
    });
    return this.chain.unsigned(
      "submit_milestone",
      {
        creator: s.creator,
        round: r.chain_address,
        milestone: this.chain.milestone(r.chain_address, m.sequence),
      },
      { evidence_hash: e.evidence_hash },
      s.creator,
    );
  }
  async analyzeMilestone(user, id) {
    await this.db.staff(user);
    await this.milestoneContext(user, id);
    return this.saveContextAnalysis(
      await analysisInput(this.db, "milestone", uuid(id)),
    );
  }
  async decideMilestone(user, id, body) {
    await this.db.staff(user);
    const { m, r } = await this.milestoneContext(user, id);
    const report = await this.db.one("ai_reports", {
      id: `eq.${uuid(body.reportId)}`,
      milestone_id: `eq.${m.id}`,
    });
    const evidence = await this.db.one("evidence", {
      id: `eq.${uuid(body.evidenceId)}`,
      milestone_id: `eq.${m.id}`,
    });
    let analyzed;
    try {
      analyzed = JSON.parse(report.canonical_input);
    } catch {
      analyzed = null;
    }
    if (
      report.company_id !== r.company_id ||
      !analyzed?.evidence?.some(
        (e) =>
          e.id === evidence.id && e.evidence_hash === evidence.evidence_hash,
      )
    )
      fail(
        409,
        "stale_report",
        "O relatório não analisou esta versão das evidências. Execute uma nova análise.",
      );
    const onchain = await this.chain.account(
      this.chain.milestone(r.chain_address, m.sequence),
      "Milestone",
    );
    if (
      onchain.state.evidence_hash !== evidence.evidence_hash ||
      onchain.state.plan_hash !== m.plan_hash ||
      onchain.state.status !== 1
    )
      fail(
        409,
        "evidence_not_submitted",
        "As evidências precisam corresponder à solicitação on-chain em revisão.",
      );
    if (!["approved", "rejected", "changes_requested"].includes(body.decision))
      fail(400, "invalid_decision", "Decisão inválida.");
    const document = canonical({
      milestoneId: m.id,
      reviewerId: user.id,
      decision: body.decision,
      reason: required(body.reason, "Motivo", 5000),
      reportId: report.id,
      reportInputHash: report.input_hash,
      evidenceHash: evidence.evidence_hash,
    });
    const [decision] = await this.db.insert("review_decisions", {
      company_id: r.company_id,
      milestone_id: m.id,
      reviewer_id: user.id,
      decision: body.decision,
      reason: body.reason,
      report_id: report.id,
      review_hash: sha(document),
      canonical_document: document,
    });
    return { ...decision, chainAuthorization: false };
  }
  async prepareApproval(user, id, decisionId, walletId) {
    await this.db.staff(user);
    const { m, r } = await this.milestoneContext(user, id),
      d = await this.db.one("review_decisions", {
        id: `eq.${uuid(decisionId)}`,
        milestone_id: `eq.${m.id}`,
      });
    if (d.decision !== "approved")
      fail(409, "approval_required", "Decisão não aprovada.");
    const latest = await this.db.one("review_decisions", {
      milestone_id: `eq.${m.id}`,
      order: "created_at.desc",
    });
    if (latest.id !== d.id)
      fail(409, "superseded", "Use a decisão mais recente.");
    const wallet = await this.db.one("wallets", {
        id: `eq.${uuid(walletId)}`,
        user_id: `eq.${user.id}`,
      }),
      round = (await this.chain.account(r.chain_address, "Round")).state;
    if (round.platform !== wallet.address)
      fail(
        403,
        "wrong_review_wallet",
        "Conecte a carteira RAFTT autorizada no contrato.",
      );
    const milestone = await this.chain.account(
      this.chain.milestone(r.chain_address, m.sequence),
      "Milestone",
    );
    const source = JSON.parse(d.canonical_document);
    if (
      milestone.state.status !== 1 ||
      milestone.state.evidence_hash !== source.evidenceHash
    )
      fail(
        409,
        "stale_evidence",
        "Evidências alteradas; nova revisão necessária.",
      );
    return this.chain.unsigned(
      "approve_milestone",
      {
        signer: wallet.address,
        round: r.chain_address,
        milestone: this.chain.milestone(r.chain_address, m.sequence),
      },
      { review_hash: d.review_hash },
      wallet.address,
    );
  }
  async publish(user, id) {
    await this.db.staff(user);
    const company = await this.db.company(user, uuid(id)),
      app = await this.db.one("company_applications", {
        company_id: `eq.${company.id}`,
        order: "version.desc",
      });
    if (app.status !== "approved")
      fail(
        409,
        "approval_required",
        "Candidatura atual precisa estar aprovada.",
      );
    const rounds = await this.db.rest("rounds", {
      company_id: `eq.${company.id}`,
      network: `eq.${this.cfg.network}`,
      program_id: `eq.${this.cfg.programId}`,
      limit: 100,
    });
    if (!rounds.length)
      fail(409, "round_required", "Vincule uma rodada antes de publicar.");
    let open = false;
    for (const r of rounds) {
      const s = await this.sync(r);
      if (
        s.state.status === 1 &&
        BigInt(s.state.deadline) > BigInt(Math.floor(Date.now() / 1000))
      )
        open = true;
    }
    if (!open)
      fail(409, "open_round_required", "Nenhuma rodada aberta válida.");
    return this.db.rpc("backend_publish_company", {
      p_company: company.id,
      p_reviewer: user.id,
    });
  }
}
// Round approval stays with the verified RAFTT wallet; the backend only prepares unsigned bytes.
Services.prototype.prepareOpen = async function (user, id, body) {
  await this.db.staff(user);
  const r = await this.round(user, id),
    s = (await this.chain.account(r.chain_address, "Round")).state;
  const app = await this.db.one("company_applications", {
    company_id: `eq.${r.company_id}`,
    order: "version.desc",
  });
  if (
    app.status !== "approved" ||
    s.status !== 0 ||
    s.allocated !== s.minimum ||
    s.milestone_count < 1
  )
    fail(
      409,
      "not_ready",
      "Aprovação atual e plano inicial completo são necessários.",
    );
  const w = await this.db.one("wallets", {
    id: `eq.${uuid(body.walletId)}`,
    user_id: `eq.${user.id}`,
  });
  if (w.address !== s.platform)
    fail(403, "wrong_review_wallet", "Carteira não é a autoridade RAFTT.");
  const decision = await this.db.one("review_decisions", {
    application_id: `eq.${app.id}`,
    decision: "eq.approved",
    order: "created_at.desc",
  });
  const document = canonical({
    roundId: r.id,
    planHash: s.plan_hash,
    minimum: s.minimum,
    cap: s.cap,
    applicationDecision: decision.id,
    applicationReviewHash: decision.review_hash,
  });
  return {
    ...(await this.chain.unsigned(
      "open_round",
      { signer: w.address, round: r.chain_address },
      { review_hash: sha(document) },
      w.address,
    )),
    reviewDocument: document,
    reviewHash: sha(document),
  };
};
Services.prototype.acceptTerms = async function (user, id, body) {
  const r = await this.round(user, id);
  if (body.termsVersion !== r.terms_version)
    fail(409, "terms_changed", "Revise a versão atual dos termos.");
  return this.db.upsert(
    "terms_acceptances",
    {
      user_id: user.id,
      round_id: r.id,
      terms_version: r.terms_version,
      terms_hash: sha(canonical(r.terms)),
    },
    "user_id,round_id,terms_version",
  );
};
Services.prototype.recordTransaction = async function (user, id, body) {
  const r = await this.round(user, id),
    operation = body.operation;
  const allowed = [
    "invest_round",
    "cancel_round",
    "refund_round",
    "close_round",
    "open_round",
    "fail_round",
    "submit_milestone",
    "approve_milestone",
    "release_milestone",
  ];
  if (!allowed.includes(operation))
    fail(400, "unknown_operation", "Operação não permitida.");
  const wallet = await this.db.one("wallets", {
    id: `eq.${uuid(body.walletId)}`,
    user_id: `eq.${user.id}`,
  });
  const expected = { round: r.chain_address };
  if (["invest_round", "cancel_round", "refund_round"].includes(operation)) {
    expected.investor = wallet.address;
    expected.position = this.chain.position(r.chain_address, wallet.address);
  }
  if (["open_round", "fail_round", "approve_milestone"].includes(operation)) {
    await this.db.staff(user);
    expected.signer = wallet.address;
  }
  if (operation === "submit_milestone") {
    await this.db.company(user, r.company_id, { owner: true });
    expected.creator = wallet.address;
  }
  if (
    ["submit_milestone", "approve_milestone", "release_milestone"].includes(
      operation,
    )
  ) {
    if (
      !Number.isInteger(body.sequence) ||
      body.sequence < 0 ||
      body.sequence > 65535
    )
      fail(400, "invalid_sequence", "Índice inválido.");
    expected.milestone = this.chain.milestone(r.chain_address, body.sequence);
  }
  const proof = await this.chain.transaction(
    body.signature,
    operation,
    expected,
    undefined,
    wallet.address,
  );
  const existing = await this.db.rest("chain_transactions", {
    network: `eq.${this.cfg.network}`,
    signature: `eq.${body.signature}`,
  });
  if (existing.length) {
    if (existing[0].round_id !== r.id || existing[0].user_id !== user.id)
      fail(
        409,
        "transaction_claimed",
        "Transação já registrada para outra operação.",
      );
    return existing[0];
  }
  const [tx] = await this.db.insert("chain_transactions", {
    network: this.cfg.network,
    signature: body.signature,
    user_id: user.id,
    round_id: r.id,
    operation,
    status: "confirmed",
    chain_time: proof.chain_time,
  });
  await this.sync(r);
  if (["invest_round", "cancel_round", "refund_round"].includes(operation))
    await this.syncPositions(user, id);
  return tx;
};

Services.prototype.prepareClose = async function (user, id, body) {
  const r = await this.round(user, id),
    s = (await this.chain.account(r.chain_address, "Round")).state;
  const slot = await this.chain.rpc("getSlot", [{ commitment: "finalized" }]),
    now = await this.chain.rpc("getBlockTime", [slot]);
  if (now === null || s.status !== 1 || BigInt(now) < BigInt(s.deadline))
    fail(
      409,
      "deadline_not_reached",
      "Rodada precisa estar aberta e o prazo encerrado na rede.",
    );
  const w = await this.db.one("wallets", {
    id: `eq.${uuid(body.walletId)}`,
    user_id: `eq.${user.id}`,
  });
  return this.chain.unsigned(
    "close_round",
    { round: r.chain_address },
    {},
    w.address,
  );
};
Services.prototype.prepareRelease = async function (user, id, body) {
  const { m, r } = await this.milestoneContext(user, id),
    s = (await this.chain.account(r.chain_address, "Round")).state,
    ms = (
      await this.chain.account(
        this.chain.milestone(r.chain_address, m.sequence),
        "Milestone",
      )
    ).state;
  if (s.status !== 2 || ms.status !== 2 || s.next_release !== m.sequence)
    fail(
      409,
      "release_unavailable",
      "Parcela precisa estar autorizada e na ordem de pagamento.",
    );
  const w = await this.db.one("wallets", {
    id: `eq.${uuid(body.walletId)}`,
    user_id: `eq.${user.id}`,
  });
  return this.chain.release(r.chain_address, s, m.sequence, w.address);
};
