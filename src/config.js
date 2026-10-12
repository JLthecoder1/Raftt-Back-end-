import { address, fail } from "./core.js";
export function config(env = process.env) {
  const out = {
    port: Number(env.PORT || 3000),
    supabaseUrl: env.SUPABASE_URL,
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    network: env.SOLANA_NETWORK || "devnet",
    rpcUrl: env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    programId:
      env.SOLANA_PROGRAM_ID || "7rxcmdNRE9Ve7ocjAzG1S5LxyPxuSQ5fifhydpRJqt85",
    origins: (
      env.ALLOWED_ORIGINS || "http://127.0.0.1:8765,http://localhost:8765"
    )
      .split(",")
      .map((x) => new URL(x.trim()).origin),
    openaiKey: env.OPENAI_API_KEY,
    aiProvider: env.AI_PROVIDER || (env.GEMINI_API_KEY ? "gemini" : "openai"),
    geminiKey: env.GEMINI_API_KEY,
    model:
      env.AI_PROVIDER === "gemini" || (!env.AI_PROVIDER && env.GEMINI_API_KEY)
        ? env.GEMINI_MODEL
        : env.OPENAI_MODEL,
    agentEnabled: env.AGENT_AUTORUN !== "false",
    agentPollMs: Number(env.AGENT_POLL_MS || 10000),
    jobToken: env.JOB_TOKEN,
    allowedMints: (env.ALLOWED_MINTS || "").split(",").filter(Boolean),
  };
  if (!out.supabaseUrl || !out.publishableKey || !out.serviceKey)
    fail(
      500,
      "missing_config",
      "Configure Supabase URL, publishable key e service role no servidor.",
    );
  const url = new URL(out.supabaseUrl),
    rpc = new URL(out.rpcUrl);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    fail(500, "invalid_config", "Supabase exige HTTPS.");
  if (!["devnet", "localnet"].includes(out.network))
    fail(500, "invalid_config", "Somente redes de teste.");
  if (
    out.network === "localnet" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(rpc.hostname)
  )
    fail(500, "invalid_config", "RPC localnet inválido.");
  if (out.network === "devnet" && rpc.protocol !== "https:")
    fail(500, "invalid_config", "Devnet exige HTTPS.");
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535)
    fail(500, "invalid_config", "Porta inválida.");
  if (
    !["gemini", "openai"].includes(out.aiProvider) ||
    (out.model && !/^[a-zA-Z0-9_.:-]+$/.test(out.model))
  )
    fail(500, "invalid_config", "Provedor ou modelo da IA inválido.");
  if (
    !Number.isInteger(out.agentPollMs) ||
    out.agentPollMs < 1000 ||
    out.agentPollMs > 600000
  )
    fail(500, "invalid_config", "Intervalo do agente inválido.");
  out.documentationOrigins = [`http://localhost:${out.port}`, `http://127.0.0.1:${out.port}`];
  if (env.PUBLIC_API_URL) {
    const publicUrl = new URL(env.PUBLIC_API_URL);
    if (publicUrl.protocol !== "https:") fail(500, "invalid_config", "PUBLIC_API_URL exige HTTPS.");
    out.documentationOrigins.push(publicUrl.origin);
  }
  address(out.programId);
  return out;
}
