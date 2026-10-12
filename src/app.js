import { serveDocumentation } from "./docs.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { ApiError, uuid, fail, JSONbig, validateDepth } from "./core.js";
export function createApp({ db, chain, services, cfg }) {
  const limits = new Map();
  function rate(key, max = 120) {
    const now = Date.now(),
      entry = limits.get(key);
    if (entry && entry.until > now) {
      if (++entry.count > max)
        fail(
          429,
          "rate_limit",
          "Muitas solicitações. Tente novamente em um minuto.",
        );
    } else {
      if (limits.size > 10000) {
        for (const [k, v] of limits) if (v.until <= now) limits.delete(k);
        if (limits.size > 10000) fail(429, "rate_limit", "Servidor ocupado.");
      }
      limits.set(key, { count: 1, until: now + 60000 });
    }
  }
  function jobAuthorized(req) {
    const provided = req.headers.authorization?.replace(/^Bearer /, "") || "",
      expected = cfg.jobToken;
    if (!expected || provided.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  }
  async function body(req) {
    const buffers = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 262144)
        fail(
          413,
          "body_too_large",
          "Limite de 256 KB. Use Storage para arquivos.",
        );
      buffers.push(chunk);
    }
    if (!size) return {};
    if (!req.headers["content-type"]?.startsWith("application/json"))
      fail(415, "json_required", "Use application/json.");
    let value;
    try {
      value = JSONbig.parse(Buffer.concat(buffers).toString("utf8"));
    } catch {
      fail(400, "invalid_json", "JSON inválido.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail(400, "invalid_json", "Objeto JSON obrigatório.");
    return validateDepth(value);
  }
  return async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const send = (status, data) => {
      res.statusCode = status;
      res.end(
        JSON.stringify(data, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      );
    };
    try {
      const origin = req.headers.origin;
      if (origin && !cfg.origins.includes(origin) && !cfg.documentationOrigins?.includes(origin))
        fail(403, "origin_not_allowed", "Origem não permitida.");
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization,Content-Type",
        );
        return send(204, null);
      }
      const url = new URL(req.url, "http://backend"),
        path = url.pathname;
      if (serveDocumentation(req, res, path)) return;
      if (req.method === "GET" && path === "/health")
        return send(200, {
          status: "ok",
          network: cfg.network,
          programId: cfg.programId,
          aiConfigured: services.ai?.configured?.() || false,
          agentEnabled:
            !!cfg.agentEnabled && (services.ai?.configured?.() || false),
          aiProvider: cfg.aiProvider,
        });
      rate("ip:" + req.socket.remoteAddress, 300);
      if (path === "/jobs/sync" && req.method === "POST") {
        if (!jobAuthorized(req))
          fail(401, "unauthorized", "Credencial de tarefa inválida.");
        rate("jobs", 2);
        await chain.ready();
        const rows = await db.rest("rounds", {
          network: `eq.${cfg.network}`,
          program_id: `eq.${cfg.programId}`,
          order: "synced_at.asc.nullsfirst",
          limit: 50,
        });
        const results = [];
        for (const r of rows) {
          try {
            await services.sync(r);
            results.push({ roundId: r.id, status: "synced" });
          } catch (e) {
            results.push({
              roundId: r.id,
              status: "error",
              code: e.code || "internal_error",
            });
          }
        }
        return send(200, { results });
      }
      const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
      const user = await db.authenticate(token);
      rate("user:" + user.id);
      const data = req.method === "POST" ? await body(req) : {};
      let match, result;
      if (req.method === "GET" && path === "/v1/me")
        result = { id: user.id, email: user.email };
      else if (req.method === "GET" && path === "/v1/wallets")
        result = await db.rest("wallets", {
          user_id: `eq.${user.id}`,
          limit: 100,
        });
      else if (req.method === "POST" && path === "/v1/wallets/challenges") {
        rate("challenge:" + user.id, 10);
        result = await services.challenge(user, data, origin);
      } else if (req.method === "POST" && path === "/v1/wallets/verify")
        result = await services.verify(user, data);
      else if (req.method === "GET" && path === "/v1/companies")
        result = await db.rest(
          "companies",
          url.searchParams.get("mine") === "true"
            ? { owner_id: `eq.${user.id}`, limit: 100 }
            : { publication_status: "eq.published", limit: 100 },
        );
      else if (
        req.method === "GET" &&
        (match = path.match(/^\/v1\/companies\/([^/]+)$/))
      )
        result = await db.company(user, uuid(match[1]), { publicRead: true });
      else if (
        req.method === "GET" &&
        (match = path.match(/^\/v1\/companies\/([^/]+)\/agent-jobs$/))
      ) {
        const id = uuid(match[1]);
        await db.company(user, id);
        result = await db.rest("agent_jobs", {
          company_id: "eq." + id,
          select:
            "id,kind,target_id,source_id,status,attempts,error_code,report_id,created_at,updated_at",
          order: "created_at.desc",
          limit: 100,
        });
      } else if (
        req.method === "GET" &&
        (match = path.match(/^\/v1\/companies\/([^/]+)\/applications$/))
      ) {
        const id = uuid(match[1]);
        await db.company(user, id);
        result = await db.rest("company_applications", {
          company_id: `eq.${id}`,
          order: "version.desc",
          limit: 20,
        });
      } else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/companies\/([^/]+)\/publish$/))
      )
        result = await services.publish(user, match[1]);
      else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/applications\/([^/]+)\/analyze$/))
      ) {
        rate("ai:" + user.id, 5);
        result = await services.analyzeApplication(user, match[1]);
      } else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/applications\/([^/]+)\/decisions$/))
      )
        result = await services.decideApplication(user, match[1], data);
      else if (req.method === "POST" && path === "/v1/rounds/prepare")
        result = await services.prepareRound(user, data);
      else if (req.method === "POST" && path === "/v1/rounds/register")
        result = await services.registerRound(user, data);
      else if (
        req.method === "GET" &&
        (match = path.match(/^\/v1\/rounds\/([^/]+)$/))
      )
        result = await services.round(user, match[1]);
      else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/rounds\/([^/]+)\/sync$/))
      ) {
        rate("sync:" + user.id, 10);
        result = await services.syncRound(user, match[1]);
      } else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/rounds\/([^/]+)\/open\/prepare$/))
      )
        result = await services.prepareOpen(user, match[1], data);
      else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/rounds\/([^/]+)\/milestones$/))
      )
        result = await services.recordMilestone(user, match[1], data);
      else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/rounds\/([^/]+)\/positions\/sync$/))
      )
        result = await services.syncPositions(user, match[1]);
      else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/rounds\/([^/]+)\/terms$/))
      )
        result = await services.acceptTerms(user, match[1], data);
      else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/rounds\/([^/]+)\/transactions$/))
      )
        result = await services.recordTransaction(user, match[1], data);
      else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/rounds\/([^/]+)\/close\/prepare$/))
      )
        result = await services.prepareClose(user, match[1], data);
      else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/milestones\/([^/]+)\/release\/prepare$/))
      )
        result = await services.prepareRelease(user, match[1], data);
      else if (req.method === "GET" && path === "/v1/investments")
        result = await db.rest("investments", {
          user_id: `eq.${user.id}`,
          limit: 100,
        });
      else if (
        req.method === "GET" &&
        (match = path.match(/^\/v1\/milestones\/([^/]+)$/))
      )
        result = (await services.milestoneContext(user, match[1])).m;
      else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/milestones\/([^/]+)\/evidence$/))
      )
        result = await services.evidence(user, match[1], data);
      else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/milestones\/([^/]+)\/evidence\/prepare$/))
      )
        result = await services.prepareEvidence(
          user,
          match[1],
          data.evidenceId,
        );
      else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/milestones\/([^/]+)\/analyze$/))
      ) {
        rate("ai:" + user.id, 1);
        result = await services.analyzeMilestone(user, match[1]);
      } else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/milestones\/([^/]+)\/decisions$/))
      )
        result = await services.decideMilestone(user, match[1], data);
      else if (
        req.method === "POST" &&
        (match = path.match(/^\/v1\/milestones\/([^/]+)\/approval\/prepare$/))
      )
        result = await services.prepareApproval(
          user,
          match[1],
          data.decisionId,
          data.walletId,
        );
      else if (req.method === "GET" && path === "/v1/notifications")
        result = await db.rest("notifications", {
          user_id: `eq.${user.id}`,
          order: "created_at.desc",
          limit: 100,
        });
      else fail(404, "route_not_found", "Endpoint não encontrado.");
      if (req.method === "POST") {
        try {
          await db.insert("audit_events", {
            actor_id: user.id,
            entity_table: "backend_api",
            entity_id: path,
            operation: "POST",
          });
        } catch {
          console.error(
            JSON.stringify({ requestId, code: "audit_write_failed" }),
          );
        }
      }
      return send(200, { data: result });
    } catch (e) {
      const known = e instanceof ApiError;
      const status = known ? e.status : 500;
      console.error(
        JSON.stringify({
          requestId,
          status,
          code: known ? e.code : "internal_error",
        }),
      );
      return send(status, {
        error: {
          code: known ? e.code : "internal_error",
          message: known ? e.message : "Erro interno.",
          requestId,
        },
      });
    }
  };
}
