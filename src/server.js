import { AgentWorker } from "./agent-worker.js";
import { createServer } from "node:http";
import { config } from "./config.js";
import { Database } from "./database.js";
import { Solana } from "./solana.js";
import { Analyst } from "./ai.js";
import { Services } from "./services.js";
import { createApp } from "./app.js";
const cfg = config(),
  db = new Database(cfg),
  chain = new Solana(cfg),
  ai = new Analyst(cfg),
  services = new Services(db, chain, ai, cfg);
const worker = new AgentWorker(db, ai, cfg);
worker.start();
const server = createServer(createApp({ db, chain, services, cfg }));
server.requestTimeout = 70000;
server.headersTimeout = 15000;
server.listen(cfg.port, "0.0.0.0", () =>
  console.log(
    `RAFTT backend listening on port ${cfg.port}; network=${cfg.network}`,
  ),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    worker.stop();
    server.close(() => process.exit(0));
  });
