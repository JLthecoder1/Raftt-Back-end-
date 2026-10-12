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
export async function fetchJSON(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(options.timeout ?? 20000),
    });
  } catch {
    fail(503, "upstream_unavailable", "Serviço externo indisponível.");
  }
  const text = await response.text();
  if (!response.ok)
    throw new ApiError(
      response.status === 401 ? 401 : 502,
      "upstream_error",
      "A operação no serviço externo falhou.",
    );
  try {
    return text ? JSONbig.parse(text) : null;
  } catch {
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
