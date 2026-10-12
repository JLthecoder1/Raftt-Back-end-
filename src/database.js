import { fetchJSON, fail } from "./core.js";
export class Database {
  constructor(cfg) {
    this.cfg = cfg;
  }
  async authenticate(token) {
    if (!token) fail(401, "unauthorized", "Entre na sua conta.");
    const user = await fetchJSON(`${this.cfg.supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: this.cfg.publishableKey,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!user?.id) fail(401, "unauthorized", "Sessão inválida.");
    return user;
  }
  async rest(
    table,
    params = {},
    method = "GET",
    body,
    prefer = "return=representation",
  ) {
    const url = new URL(`${this.cfg.supabaseUrl}/rest/v1/${table}`);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, String(value));
    return fetchJSON(url, {
      method,
      headers: {
        apikey: this.cfg.serviceKey,
        Authorization: `Bearer ${this.cfg.serviceKey}`,
        "Content-Type": "application/json",
        Prefer: prefer,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async one(table, filters, select = "*") {
    const rows = await this.rest(table, { ...filters, select, limit: 1 });
    if (!rows?.length) fail(404, "not_found", "Registro não encontrado.");
    return rows[0];
  }
  insert(table, body) {
    return this.rest(table, {}, "POST", body);
  }
  update(table, filters, body) {
    return this.rest(table, filters, "PATCH", body);
  }
  upsert(table, body, conflict) {
    return this.rest(
      table,
      { on_conflict: conflict },
      "POST",
      body,
      "resolution=merge-duplicates,return=representation",
    );
  }
  rpc(name, body) {
    return this.rest("rpc/" + name, {}, "POST", body);
  }
  async documentBytes(doc, maxBytes) {
    if (doc.bucket !== "company-private" || !doc.object_path || maxBytes <= 0)
      fail(413, "document_too_large", "Documento excede o limite de análise.");
    const path = doc.object_path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(
      `${this.cfg.supabaseUrl}/storage/v1/object/authenticated/company-private/${path}`,
      {
        headers: {
          apikey: this.cfg.serviceKey,
          Authorization: `Bearer ${this.cfg.serviceKey}`,
        },
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok)
      fail(
        502,
        "document_unavailable",
        "Não foi possível ler o documento privado.",
      );
    const mimeType = response.headers.get("content-type")?.split(";")[0];
    if (
      !["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(
        mimeType,
      )
    ) {
      await response.body?.cancel();
      fail(422, "unsupported_document", "Formato não suportado para análise.");
    }
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      fail(413, "document_too_large", "Documento excede o limite de análise.");
    }
    const reader = response.body.getReader(),
      chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        fail(
          413,
          "document_too_large",
          "Documento excede o limite de análise.",
        );
      }
      chunks.push(Buffer.from(value));
    }
    return { mimeType, bytes: Buffer.concat(chunks) };
  }
  async staff(user) {
    const rows = await this.rest("platform_staff", {
      user_id: `eq.${user.id}`,
      select: "role",
    });
    if (!rows.length)
      fail(403, "staff_required", "Ação reservada à equipe RAFTT.");
    return rows[0].role;
  }
  async company(user, id, { owner = false, publicRead = false } = {}) {
    const company = await this.one("companies", { id: `eq.${id}` });
    if (company.owner_id === user.id) return company;
    if (owner)
      fail(403, "owner_required", "Somente a pessoa responsável pela empresa.");
    if (publicRead && company.publication_status === "published")
      return company;
    const members = await this.rest("company_members", {
      company_id: `eq.${id}`,
      user_id: `eq.${user.id}`,
      select: "role",
    });
    if (members.length) return company;
    await this.staff(user);
    return company;
  }
}
