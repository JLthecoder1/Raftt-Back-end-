import { createHash, createPublicKey, verify, randomBytes } from "node:crypto";
import JSONbigFactory from "json-bigint";
import bs58 from "bs58";
export const JSONbig = JSONbigFactory({
  storeAsString: true,
  protoAction: "error",
  constructorAction: "error",
});
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const fail = (status, code, message) => {
  throw new ApiError(status, code, message);
};
export function required(value, name, max = 10000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(400, "invalid_input", `${name} inválido.`);
  return value;
}
export function uuid(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
  )
    fail(400, "invalid_uuid", "UUID inválido.");
  return value;
}
export function u64(value) {
  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    fail(400, "invalid_amount", "Informe u64 como texto decimal.");
  return BigInt(value).toString();
}
export function address(value) {
  try {
    if (typeof value !== "string" || bs58.decode(value).length !== 32)
      throw Error();
    return value;
  } catch {
    fail(400, "invalid_address", "Endereço Solana inválido.");
  }
}
export const sha = (text) => createHash("sha256").update(text).digest("hex");
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
      .join(",") +
    "}"
  );
}
export function walletMessage({ userId, wallet, nonce, expiresAt, origin }) {
  return `RAFTT wallet verification\nOrigin: ${origin}\nUser: ${userId}\nWallet: ${wallet}\nNonce: ${nonce}\nExpires: ${expiresAt}\nThis signature links a wallet to your RAFTT account. It does not authorize a transfer.`;
}
export function verifyWallet(wallet, message, signature) {
  try {
    if (typeof signature !== "string" || signature.length > 150) return false;
    const bytes = Buffer.from(signature, "base64");
    if (bytes.length !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(bs58.decode(wallet)),
      ]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(message, "utf8"), key, bytes);
  } catch {
    return false;
  }
}
export const nonce = () => randomBytes(32).toString("hex");
// Keep diagnostics limited to host, operation, status and machine-readable code.
// Never log headers, query strings, request bodies or upstream error messages.
function upstreamContext(url, options) {
  const parsed = new URL(String(url));
  let operation = "http";
  const rest = parsed.pathname.match(/^\/rest\/v1\/(?:rpc\/)?([a-zA-Z0-9_]+)\/?$/);
  if (rest) operation = (options.method || "GET") + " " + rest[1];
  else if (parsed.pathname === "/auth/v1/user") operation = "auth-user";
  else {
    try {
      const method = JSON.parse(options.body || "{}").method;
      if (typeof method === "string" && /^[a-zA-Z0-9_]{1,64}$/.test(method))
        operation = method;
    } catch {}
  }
  return { host: parsed.hostname, operation };
}
export async function fetchJSON(url, options = {}) {
  const context = upstreamContext(url, options);
  const diagnostic = (status, code) => console.error(JSON.stringify({
    event: "upstream_failure", ...context, status, upstreamCode: code,
  }));
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(options.timeout ?? 20000),
    });
  } catch {
    diagnostic(null, "connection_or_timeout");
    fail(503, "upstream_unavailable", "Serviço externo indisponível.");
  }
  let text;
  try {
    text = await response.text();
  } catch {
    diagnostic(response.status, "response_read_failed");
    fail(503, "upstream_unavailable", "Não foi possível ler a resposta externa.");
  }
  if (!response.ok) {
    let code = "http_error";
    try {
      const result = JSONbig.parse(text);
      const candidate = result?.code ?? result?.error?.status ?? result?.error?.code;
      if (typeof candidate === "number" ||
          (typeof candidate === "string" && /^[A-Z0-9_]{1,64}$/.test(candidate)))
        code = String(candidate);
    } catch {}
    diagnostic(response.status, code);
    throw new ApiError(
      response.status === 401 ? 401 : 502,
      "upstream_error",
      "A operação no serviço externo falhou (HTTP " + response.status + ").",
    );
  }
  try {
    return text ? JSONbig.parse(text) : null;
  } catch {
    diagnostic(response.status, "invalid_json");
    fail(502, "invalid_upstream", "Resposta externa inválida.");
  }
}

export function validateDepth(value, depth = 0, counter = { n: 0 }) {
  if (++counter.n > 20000 || depth > 32)
    fail(400, "complex_input", "JSON muito complexo.");
  if (value && typeof value === "object")
    for (const item of Object.values(value))
      validateDepth(item, depth + 1, counter);
  return value;
}
