// Load after the existing Supabase and Solana clients. No privileged key belongs here.
(() => {
  "use strict";
  const config = window.RafttApiConfig;
  if (!config?.baseUrl) return;
  const base = new URL(config.baseUrl);
  if (
    base.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(base.hostname)
  )
    throw Error("Backend exige HTTPS fora do localhost.");
  async function request(path, body) {
    const { data, error } = await window.RafttBackend.db.auth.getSession();
    if (error || !data.session) throw Error("Entre na sua conta.");
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + data.session.access_token,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error?.message || "Erro da API.");
    return result.data;
  }
  const toBase64 = (bytes) => {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  };
  async function verifyWallet(provider) {
    if (!provider?.publicKey || !provider.signMessage)
      throw Error("Conecte uma carteira que assina mensagens.");
    const address = provider.publicKey.toBase58();
    const challenge = await request("/v1/wallets/challenges", { address });
    const signature = await provider.signMessage(
      new TextEncoder().encode(challenge.message),
      "utf8",
    );
    if (provider.publicKey?.toBase58() !== address)
      throw Error("Carteira alterada.");
    return request("/v1/wallets/verify", {
      challengeId: challenge.id,
      signature: toBase64(signature.signature || signature),
    });
  }
  async function signPrepared(provider, prepared) {
    const W = window.solanaWeb3;
    if (!W || !provider?.publicKey) throw Error("Conecte a carteira.");
    const owner = provider.publicKey.toBase58();
    await window.RafttV2Bridge.ready();
    const tx = W.Transaction.from(
      Uint8Array.from(atob(prepared.transaction), (c) => c.charCodeAt(0)),
    );
    if (
      tx.instructions.some(
        (ix) =>
          ![
            window.RafttSolanaConfig.programId,
            "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
          ].includes(ix.programId.toBase58()),
      )
    )
      throw Error("Programa inesperado na transação.");
    if (tx.feePayer?.toBase58() !== owner)
      throw Error("Transação preparada para outra carteira.");
    const signed = await provider.signTransaction(tx);
    if (provider.publicKey?.toBase58() !== owner)
      throw Error("Carteira alterada.");
    const rpc = window.RafttV2Bridge.rpc();
    const signature = await rpc.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
    });
    const result = await rpc.confirmTransaction(
      {
        signature,
        blockhash: tx.recentBlockhash,
        lastValidBlockHeight: prepared.last_valid_block_height,
      },
      "finalized",
    );
    if (result.value.err) throw Error("Transação falhou.");
    return signature;
  }
  async function createLinkedRound(provider, params) {
    const wallet = await verifyWallet(provider);
    const prepared = await request("/v1/rounds/prepare", {
      ...params,
      walletId: wallet.id,
    });
    const signature = await signPrepared(provider, prepared);
    const round = await request("/v1/rounds/register", {
      draftId: prepared.draftId,
      signature,
    });
    return { round, signature };
  }
  window.RafttApi = { request, verifyWallet, signPrepared, createLinkedRound };
})();
