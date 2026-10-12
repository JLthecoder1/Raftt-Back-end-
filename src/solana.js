import { readFileSync } from "node:fs";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import bs58 from "bs58";
import { fetchJSON, fail, address } from "./core.js";
export const IDL = JSON.parse(
  readFileSync(new URL("../idl/raftt.json", import.meta.url), "utf8"),
);
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export function decodeAccount(kind, bytes) {
  const spec = IDL.accounts.find((a) => a.name === kind),
    type = IDL.types.find((t) => t.name === kind);
  if (!spec || !type) fail(422, "unknown_layout", "Layout desconhecido.");
  const b = Buffer.from(bytes);
  if (!spec.discriminator.every((x, i) => b[i] === x))
    fail(422, "wrong_discriminator", "Conta de outro tipo.");
  let offset = 8;
  const out = {};
  for (const f of type.type.fields) {
    const type = f.type;
    let value, n;
    if (type === "pubkey") {
      n = 32;
      value = () => new PublicKey(b.subarray(offset, offset + 32)).toBase58();
    } else if (type === "u64") {
      n = 8;
      value = () => b.readBigUInt64LE(offset).toString();
    } else if (type === "i64") {
      n = 8;
      value = () => b.readBigInt64LE(offset).toString();
    } else if (type === "u16") {
      n = 2;
      value = () => b.readUInt16LE(offset);
    } else if (type === "u8" || type === "bool") {
      n = 1;
      value = () => (type === "bool" ? !!b[offset] : b[offset]);
    } else if (type?.array?.[0] === "u8") {
      n = type.array[1];
      value = () => b.subarray(offset, offset + n).toString("hex");
    } else fail(422, "unsupported_layout", "Tipo não suportado.");
    if (offset + n > b.length) fail(422, "short_account", "Conta incompleta.");
    out[f.name] = value();
    offset += n;
  }
  if (offset !== b.length)
    fail(422, "wrong_size", "Tamanho de conta incompatível com IDL.");
  return out;
}
export function encodeArg(type, value) {
  if (type === "pubkey") return new PublicKey(value).toBuffer();
  if (type === "u64" || type === "i64") {
    const b = Buffer.alloc(8);
    type === "u64"
      ? b.writeBigUInt64LE(BigInt(value))
      : b.writeBigInt64LE(BigInt(value));
    return b;
  }
  if (type === "u16") {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(value);
    return b;
  }
  if (type?.array?.[0] === "u8") {
    const b = Buffer.from(value, "hex");
    if (b.length !== type.array[1]) fail(400, "invalid_hash", "Hash inválido.");
    return b;
  }
  fail(400, "unsupported_argument", "Argumento não suportado.");
}
export const uintBytes = (value, size = 8) => {
  const b = Buffer.alloc(size);
  size === 8
    ? b.writeBigUInt64LE(BigInt(value))
    : b.writeUInt16LE(Number(value));
  return b;
};
export class Solana {
  constructor(cfg) {
    this.cfg = cfg;
    this.program = new PublicKey(cfg.programId);
    if (IDL.address !== cfg.programId)
      fail(500, "idl_mismatch", "Program ID e IDL diferentes.");
  }
  pda(...seeds) {
    return PublicKey.findProgramAddressSync(
      seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)),
      this.program,
    )[0].toBase58();
  }
  round(creator, id) {
    return this.pda(
      "round-v2",
      new PublicKey(creator).toBuffer(),
      uintBytes(id),
    );
  }
  position(round, investor) {
    return this.pda(
      "position-v2",
      new PublicKey(round).toBuffer(),
      new PublicKey(investor).toBuffer(),
    );
  }
  milestone(round, index) {
    return this.pda(
      "milestone-v2",
      new PublicKey(round).toBuffer(),
      uintBytes(index, 2),
    );
  }
  async rpc(method, params = []) {
    const body = await fetchJSON(this.cfg.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (body?.error)
      fail(503, "rpc_error", "RPC Solana indisponível para a consulta.");
    return body.result;
  }
  async ready() {
    const genesis = await this.rpc("getGenesisHash");
    if (
      genesis === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" ||
      (this.cfg.network === "devnet" &&
        genesis !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1")
    )
      fail(503, "wrong_network", "RPC não corresponde à rede de teste.");
    const info = await this.rpc("getAccountInfo", [
      this.cfg.programId,
      { encoding: "base64", commitment: "finalized" },
    ]);
    if (!info?.value?.executable)
      fail(503, "program_missing", "Programa não publicado.");
  }
  async account(addr, kind, minSlot = 0) {
    address(addr);
    const result = await this.rpc("getAccountInfo", [
      addr,
      {
        encoding: "base64",
        commitment: "finalized",
        ...(minSlot ? { minContextSlot: minSlot } : {}),
      },
    ]);
    if (!result?.value)
      fail(404, "chain_account_missing", "Conta não encontrada na rede.");
    if (result.value.owner !== this.cfg.programId)
      fail(422, "wrong_owner", "Conta não pertence ao programa RAFTT.");
    return {
      slot: result.context.slot,
      state: decodeAccount(kind, Buffer.from(result.value.data[0], "base64")),
    };
  }
  async mint(addr) {
    const r = await this.rpc("getAccountInfo", [
      address(addr),
      { encoding: "base64", commitment: "finalized" },
    ]);
    const b = r?.value?.data && Buffer.from(r.value.data[0], "base64");
    if (r?.value?.owner !== TOKEN || !b || b.length !== 82 || b[45] !== 1)
      fail(422, "invalid_mint", "Mint SPL clássico não inicializado.");
    if (this.cfg.allowedMints.length && !this.cfg.allowedMints.includes(addr))
      fail(422, "mint_not_allowed", "Mint não permitido neste ambiente.");
    return { decimals: b[44] };
  }
  async snapshot(addr) {
    const r = await this.account(addr, "Round");
    if (
      this.round(r.state.creator, r.state.round_id) !== addr ||
      this.pda("vault-v2", new PublicKey(addr).toBuffer()) !== r.state.vault
    )
      fail(422, "wrong_pda", "PDA da rodada/cofre inválida.");
    const mint = await this.mint(r.state.mint);
    const vault = await this.rpc("getAccountInfo", [
      r.state.vault,
      { encoding: "base64", commitment: "finalized", minContextSlot: r.slot },
    ]);
    const data =
      vault?.value?.data && Buffer.from(vault.value.data[0], "base64");
    if (
      vault?.value?.owner !== TOKEN ||
      !data ||
      data.length !== 165 ||
      new PublicKey(data.subarray(0, 32)).toBase58() !== r.state.mint ||
      new PublicKey(data.subarray(32, 64)).toBase58() !== addr
    )
      fail(422, "wrong_vault", "Cofre inválido.");
    return {
      ...r,
      decimals: mint.decimals,
      vault_units: data.readBigUInt64LE(64).toString(),
    };
  }
  async transaction(
    signature,
    name,
    expectedAccounts,
    expectedData,
    requiredSigner,
  ) {
    if (
      typeof signature !== "string" ||
      !signature.length ||
      signature.length > 100
    )
      fail(400, "invalid_signature", "Assinatura inválida.");
    try {
      if (bs58.decode(signature).length !== 64) throw Error();
    } catch {
      fail(400, "invalid_signature", "Assinatura inválida.");
    }
    const tx = await this.rpc("getTransaction", [
      signature,
      {
        encoding: "json",
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      },
    ]);
    return this.verifyTransaction(
      tx,
      name,
      expectedAccounts,
      expectedData,
      requiredSigner,
    );
  }
  verifyTransaction(tx, name, expectedAccounts, expectedData, requiredSigner) {
    if (!tx?.meta || tx.meta.err !== null)
      fail(
        409,
        "transaction_not_finalized",
        "Transação ausente, falhada ou ainda não finalizada.",
      );
    const msg = tx.transaction?.message,
      spec = IDL.instructions.find((i) => i.name === name);
    if (!msg || !spec)
      fail(422, "wrong_transaction", "Transação incompatível.");
    if (
      requiredSigner &&
      !msg.accountKeys
        .slice(0, msg.header.numRequiredSignatures)
        .includes(requiredSigner)
    )
      fail(422, "wrong_signer", "Carteira não assinou esta transação.");
    const keys = [
      ...msg.accountKeys,
      ...(tx.meta.loadedAddresses?.writable || []),
      ...(tx.meta.loadedAddresses?.readonly || []),
    ];
    const matched = (msg.instructions || []).some((ix) => {
      if (keys[ix.programIdIndex] !== this.cfg.programId) return false;
      let data;
      try {
        data = Buffer.from(bs58.decode(ix.data));
      } catch {
        return false;
      }
      if (!spec.discriminator.every((x, i) => data[i] === x)) return false;
      if (expectedData && !data.equals(Buffer.from(expectedData, "base64")))
        return false;
      for (const [name, expected] of Object.entries(expectedAccounts)) {
        const idx = spec.accounts.findIndex((a) => a.name === name);
        if (idx < 0 || keys[ix.accounts[idx]] !== expected) return false;
        if (
          spec.accounts[idx].signer &&
          !msg.accountKeys
            .slice(0, msg.header.numRequiredSignatures)
            .includes(expected)
        )
          return false;
      }
      return true;
    });
    if (!matched)
      fail(
        422,
        "wrong_transaction",
        "Programa, instrução, argumentos ou contas não correspondem à operação.",
      );
    return {
      slot: tx.slot,
      chain_time: tx.blockTime
        ? new Date(tx.blockTime * 1000).toISOString()
        : null,
    };
  }
  async unsigned(name, accounts, args, feePayer, extra = []) {
    await this.ready();
    const spec = IDL.instructions.find((x) => x.name === name);
    if (!spec) fail(400, "unknown_instruction", "Instrução desconhecida.");
    const data = Buffer.concat([
      Buffer.from(spec.discriminator),
      ...spec.args.map((a) => encodeArg(a.type, args[a.name])),
    ]);
    const keys = spec.accounts.map((a) => ({
      pubkey: new PublicKey(a.address || accounts[a.name]),
      isSigner: !!a.signer,
      isWritable: !!a.writable,
    }));
    const ix = new TransactionInstruction({
      programId: this.program,
      keys,
      data,
    });
    const block = await this.rpc("getLatestBlockhash", [
      { commitment: "finalized" },
    ]);
    const tx = new Transaction({
      feePayer: new PublicKey(feePayer),
      ...block.value,
    }).add(...extra, ix);
    return {
      transaction: tx
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64"),
      instruction_data: data.toString("base64"),
      last_valid_block_height: block.value.lastValidBlockHeight,
    };
  }
  async createRound(params) {
    const { creator, round_id, mint } = params,
      round = this.round(creator, round_id),
      config = this.pda("platform-v2");
    const platform = await this.account(config, "PlatformConfig");
    if (platform.state.authority === creator)
      fail(
        422,
        "creator_is_reviewer",
        "Startup e autoridade RAFTT devem ser diferentes.",
      );
    const vault = this.pda("vault-v2", new PublicKey(round).toBuffer());
    return {
      ...(await this.unsigned(
        "create_round",
        {
          creator,
          config,
          mint,
          round,
          vault,
          system_program: SystemProgram.programId.toBase58(),
          token_program: TOKEN,
          rent: SYSVAR_RENT_PUBKEY.toBase58(),
        },
        params,
        creator,
      )),
      round_address: round,
    };
  }
}

Solana.prototype.release = async function (roundAddress, s, index, payer) {
  const destination = PublicKey.findProgramAddressSync(
    [
      new PublicKey(s.recipient).toBuffer(),
      new PublicKey(TOKEN).toBuffer(),
      new PublicKey(s.mint).toBuffer(),
    ],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  )[0];
  const associated = new TransactionInstruction({
    programId: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    keys: [
      { pubkey: new PublicKey(payer), isSigner: true, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      {
        pubkey: new PublicKey(s.recipient),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: new PublicKey(s.mint), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(TOKEN), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
  return this.unsigned(
    "release_milestone",
    {
      round: roundAddress,
      milestone: this.milestone(roundAddress, index),
      vault: s.vault,
      destination: destination.toBase58(),
      mint: s.mint,
      token_program: TOKEN,
    },
    {},
    payer,
    [associated],
  );
};
