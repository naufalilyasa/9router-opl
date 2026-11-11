/**
 * Register Respan Gateway as an openai-compatible chat node in 9router.
 *
 * Plain OpenAI /chat/completions gateway (https://gateway.respan.ai/v1).
 * Note: the upstream catalog lists `gemini-4-carbon`, but only the `:free`
 * suffix is callable on a credit-less workspace — the bare id returns
 * code `activation_required`. Register the id literally, `:free` included.
 *
 * Usage:
 *   RESPAN_KEY=... node scripts/register-respan.mjs
 */
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const KEY = process.env.RESPAN_KEY;
if (!KEY) {
  console.error("set RESPAN_KEY first, e.g.:");
  console.error("  RESPAN_KEY=... node scripts/register-respan.mjs");
  process.exit(1);
}

const DB_PATH = path.join(os.homedir(), ".9router/db/data.sqlite");
const NODE_ID = "openai-compatible-chat-respan";
const BASE_URL = "https://gateway.respan.ai/v1";
const PREFIX = "respan";
const MODELS = ["gemini-4-carbon:free"];

const db = new DatabaseSync(DB_PATH);
const now = new Date().toISOString();

db.exec("BEGIN");
try {
  // 1. provider node — standard openai-compatible chat transport
  db.prepare(
    `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt)
     VALUES(?, 'openai-compatible', 'Respan', ?, ?, ?)`
  ).run(NODE_ID, JSON.stringify({ prefix: PREFIX, apiType: "chat", baseUrl: BASE_URL }), now, now);

  // 2. connection — reuse the existing row's id so re-running never duplicates
  const existingConn = db.prepare(
    "SELECT id FROM providerConnections WHERE provider = ? LIMIT 1"
  ).get(NODE_ID);
  const connId = existingConn?.id || crypto.randomUUID();
  db.prepare(
    `INSERT OR REPLACE INTO providerConnections
       (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, 'apikey', 'Respan key 1', '', 1, 1, ?, ?, ?)`
  ).run(
    connId,
    NODE_ID,
    JSON.stringify({
      apiKey: KEY,
      testStatus: "active",
      providerSpecificData: {
        prefix: PREFIX,
        apiType: "chat",
        baseUrl: BASE_URL,
        nodeName: "Respan",
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        connectionNoProxy: "",
      },
    }),
    now,
    now
  );

  // 3. custom models — id stays bare: /v1/models prefixes providerAlias itself,
  // so storing "respan/<id>" would list as "respan/respan/<id>".
  for (const m of MODELS) {
    db.prepare(
      `INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`
    ).run(
      `${NODE_ID}|${m}|llm`,
      JSON.stringify({ providerAlias: PREFIX, id: m, type: "llm", name: m })
    );
  }

  // 4. rotation strategy (house default, same as other generic chat nodes)
  const settingsRow = db.prepare("SELECT id, data FROM settings LIMIT 1").get();
  const settings = JSON.parse(settingsRow?.data || "{}");
  settings.providerStrategies = settings.providerStrategies || {};
  settings.providerStrategies[NODE_ID] = { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 20 };

  if (settingsRow) {
    db.prepare("UPDATE settings SET data = ? WHERE id = ?").run(JSON.stringify(settings), settingsRow.id);
  } else {
    db.prepare("INSERT INTO settings(id, data) VALUES('default', ?)").run(JSON.stringify(settings));
  }

  db.exec("COMMIT");
  console.log("registered Respan");
  console.log("  node:      ", NODE_ID);
  console.log("  connection:", connId);
  console.log("  models:    ", MODELS.map((m) => `${PREFIX}/${m}`).join(", "));
} catch (err) {
  db.exec("ROLLBACK");
  console.error("failed:", err.message);
  process.exit(1);
}
db.close();
