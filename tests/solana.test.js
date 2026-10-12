import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { Solana, IDL, decodeAccount, encodeArg } from "../src/solana.js";
const pk = () => Keypair.generate().publicKey.toBase58(),
  creator = pk(),
  mint = pk(),
  round = pk();
const chain = new Solana({
  programId: IDL.address,
  network: "devnet",
  rpcUrl: "https://api.devnet.solana.com",
  allowedMints: [],
});
function tx({
  err = null,
  signer = true,
  program = IDL.address,
  loaded = false,
} = {}) {
  const spec = IDL.instructions.find((i) => i.name === "create_round"),
    keys = [creator, program, mint, round],
    accounts = spec.accounts.map(
      (a) => ({ creator: 0, mint: 2, round: 3 })[a.name] ?? 0,
    );
  return {
    slot: 123,
    blockTime: 100,
    transaction: {
      message: {
        accountKeys: loaded ? keys.slice(0, 3) : keys,
        header: { numRequiredSignatures: signer ? 1 : 0 },
        instructions: [
          {
            programIdIndex: 1,
            accounts,
            data: bs58.encode(
              Buffer.concat([
                Buffer.from(spec.discriminator),
                Buffer.alloc(120),
              ]),
            ),
          },
        ],
      },
    },
    meta: {
      err,
      loadedAddresses: loaded ? { writable: [round], readonly: [] } : undefined,
    },
  };
}
test("confirmed transaction validates program, instruction, accounts and required signer", () => {
  assert.equal(
    chain.verifyTransaction(tx(), "create_round", { creator, mint, round })
      .slot,
    123,
  );
  assert.throws(
    () =>
      chain.verifyTransaction(
        tx({ err: { InstructionError: [0, 1] } }),
        "create_round",
        { creator, mint, round },
      ),
    /finalizada/,
  );
  assert.throws(
    () =>
      chain.verifyTransaction(tx({ signer: false }), "create_round", {
        creator,
        mint,
        round,
      }),
    /correspondem/,
  );
  assert.throws(
    () =>
      chain.verifyTransaction(tx({ program: pk() }), "create_round", {
        creator,
        mint,
        round,
      }),
    /correspondem/,
  );
  assert.throws(
    () => chain.verifyTransaction(tx(), "create_round", { round: pk() }),
    /correspondem/,
  );
});
test("versioned transaction uses loaded account keys and rejects changed instruction bytes", () => {
  assert.equal(
    chain.verifyTransaction(tx({ loaded: true }), "create_round", {
      creator,
      mint,
      round,
    }).slot,
    123,
  );
  assert.throws(
    () =>
      chain.verifyTransaction(
        tx(),
        "create_round",
        { creator, mint, round },
        Buffer.from("wrong").toString("base64"),
      ),
    /correspondem/,
  );
});
test("Round decoder validates layout and retains exact u64", () => {
  const type = IDL.types.find((t) => t.name === "Round");
  const values = {
    creator,
    mint,
    platform: pk(),
    recipient: pk(),
    vault: pk(),
    round_id: "9007199254740993",
    minimum: "1",
    cap: "18446744073709551615",
    deadline: "2000000000",
    raised: "1",
    allocated: "1",
    released: "0",
    milestone_count: 1,
    next_release: 0,
    status: 1,
    bump: 2,
    plan_hash: "ab".repeat(32),
    review_hash: "cd".repeat(32),
  };
  const pieces = [
    Buffer.from(IDL.accounts.find((a) => a.name === "Round").discriminator),
  ];
  for (const f of type.type.fields)
    pieces.push(
      f.type === "u8"
        ? Buffer.from([values[f.name]])
        : encodeArg(f.type, values[f.name]),
    );
  const data = Buffer.concat(pieces);
  const result = decodeAccount("Round", data);
  assert.equal(result.cap, "18446744073709551615");
  assert.equal(result.round_id, "9007199254740993");
  assert.throws(
    () => decodeAccount("Round", data.subarray(0, 100)),
    /incompleta/,
  );
  data[0] ^= 1;
  assert.throws(() => decodeAccount("Round", data), /outro tipo/);
});
test("PDA derivation matches distinct round IDs and investor wallets", () => {
  assert.notEqual(chain.round(creator, "1"), chain.round(creator, "2"));
  assert.notEqual(chain.position(round, creator), chain.position(round, mint));
});
