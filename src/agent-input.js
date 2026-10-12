import { fail, sha } from "./core.js";
const supported = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export async function analysisInput(db, kind, targetId, sourceId) {
  let input,
    companyId,
    applicationId = null,
    milestoneId = null,
    docIds = [];
  if (kind === "application") {
    const a = await db.one("company_applications", { id: `eq.${targetId}` });
    const latest = await db.one("company_applications", {
      company_id: `eq.${a.company_id}`,
      order: "version.desc",
    });
    if (latest.id !== a.id)
      fail(409, "superseded", "Existe uma candidatura mais recente.");
    companyId = a.company_id;
    applicationId = a.id;
    docIds = Array.isArray(a.payload.documentIds) ? a.payload.documentIds : [];
    input = {
      kind,
      applicationId: a.id,
      version: a.version,
      payload: a.payload,
      language: a.payload.language === "en" ? "en" : "pt",
    };
  } else {
    const m = await db.one("milestones", { id: `eq.${targetId}` }),
      r = await db.one("rounds", { id: `eq.${m.round_id}` });
    const evidence = await db.rest("evidence", {
      milestone_id: `eq.${m.id}`,
      order: "created_at.desc,id.desc",
      limit: 1,
    });
    if (!evidence.length)
      fail(409, "no_evidence", "Envie evidências antes da análise.");
    if (sourceId && evidence[0].id !== sourceId)
      fail(409, "superseded", "Existe uma evidência mais recente.");
    companyId = r.company_id;
    milestoneId = m.id;
    docIds = evidence.map((e) => e.document_id).filter(Boolean);
    input = {
      kind: "milestone",
      round: r.id,
      planDocument: m.plan_document,
      criteria: m.acceptance_criteria,
      description: m.description,
      useOfFunds: m.use_of_funds,
      evidence,
      language: "pt",
    };
  }
  const rows = await db.rest("documents", {
    company_id: `eq.${companyId}`,
    select: "id,name,kind,bucket,object_path",
    limit: 100,
  });
  const documents = rows.filter((d) => docIds.includes(d.id));
  input.documents = documents.map(({ id, name, kind }) => ({ id, name, kind }));
  input.limitations = [
    "Dados declarados; nenhuma pesquisa externa ou KYC foi executada. Links não são abertos pelo agente.",
  ];
  return { input, companyId, applicationId, milestoneId, documents };
}
export async function attachDocuments(db, context, provider) {
  const attachments = [];
  let total = 0;
  for (const d of context.documents) {
    if (provider !== "gemini") {
      context.input.limitations.push(
        `Documento ${d.id} não lido: provedor configurado para texto.`,
      );
      continue;
    }
    if (attachments.length >= 4) {
      context.input.limitations.push(
        `Documento ${d.id} não lido: limite de quatro anexos por análise.`,
      );
      continue;
    }
    try {
      const file = await db.documentBytes(
        d,
        Math.min(6 * 1024 * 1024, 12 * 1024 * 1024 - total),
      );
      if (!supported.has(file.mimeType)) throw { code: "unsupported_document" };
      total += file.bytes.length;
      attachments.push({
        ...file,
        id: d.id,
        name: d.name,
        hash: sha(file.bytes),
      });
    } catch (e) {
      // A transient storage/network failure must retry, not masquerade as a completed document analysis.
      if (!["document_too_large", "unsupported_document"].includes(e.code))
        throw e;
      context.input.limitations.push(
        `Documento ${d.id} não lido: ${e.code}. Envie PDF/imagem dentro do limite.`,
      );
    }
  }
  context.input.documentsRead = attachments.map((d) => ({
    id: d.id,
    mimeType: d.mimeType,
    sha256: d.hash,
  }));
  return attachments;
}
