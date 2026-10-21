import express from "express";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { RouterState } from "./router-state.js";
import { buildRoutes, MAX_RELAY_JSON_BYTES } from "./routes.js";
import { buildPanel } from "./panel.js";
import { log, safeErrorFields } from "./log.js";
import { requestErrorHandler } from "./request-errors.js";
import { UsageCounters } from "./usage-counters.js";

process.on("uncaughtException", (error) => {
  log("error", "uncaught_exception", safeErrorFields(error));
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log("error", "unhandled_rejection", safeErrorFields(reason));
  process.exit(1);
});

const config = loadConfig();
const store = new Store(config.DATABASE_URL);
const state = new RouterState({
  maxWorkers: config.GLOSSA_MAX_WORKERS,
  maxWorkersPerAccount: config.GLOSSA_MAX_WORKERS_PER_ACCOUNT,
});
const usage = new UsageCounters({
  write: (rows) => store.recordUsage(rows),
  online: () => state.onlineTotals(),
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: MAX_RELAY_JSON_BYTES }));
const panel = buildPanel(config, store, state);
if (panel) app.use("/panel", panel);
app.use(buildRoutes(config, store, state, { usage }));
app.use(requestErrorHandler());

const server = app.listen(config.PORT, config.GLOSSA_BIND_HOST, () => {
  log("info", "relay_started", {
    host: config.GLOSSA_BIND_HOST,
    port: config.PORT,
  });
  usage.start();
});

async function shutdown(signal: string): Promise<void> {
  log("info", "relay_stopping", { signal });
  usage.stop();
  setTimeout(() => process.exit(1), 10_000).unref();
  // Flush before closing: open long polls can hold close past the deadline.
  await usage.flush();
  server.close(async () => {
    await usage.flush();
    await store.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
