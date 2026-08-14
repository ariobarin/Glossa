import express from "express";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { RouterState } from "./router-state.js";
import { buildRoutes, MAX_RELAY_JSON_BYTES } from "./routes.js";
import { buildPanel } from "./panel.js";

const config = loadConfig();
const store = new Store(config.DATABASE_URL);
const state = new RouterState();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: MAX_RELAY_JSON_BYTES }));
const panel = buildPanel(config, store);
if (panel) app.use("/panel", panel);
app.use(buildRoutes(config, store, state));

const server = app.listen(config.PORT, config.GLOSSA_BIND_HOST, () => {
  console.log(
    `Glossa relay listening on ${config.GLOSSA_BIND_HOST}:${config.PORT}.`,
  );
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down.`);
  server.close(async () => {
    await store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
