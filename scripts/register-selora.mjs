/**
 * Register Selora Gateway as an openai-compatible chat node in 9router.
 *
 * Plain OpenAI /chat/completions gateway (https://api.selora.lol/v1). No UA
 * gate, no apiType quirk — the default chat transport works as-is. Reasoning
 * arrives via reasoning_content (OpenAI alias, already lifted by the hub).
 *
 * Usage:
 *   SELORA_KEY=sk-gw-... node scripts/register-selora.mjs
 */
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const KEY = process.env.SELORA_KEY;
if (!KEY) {
  console.error("set SELORA_KEY first, e.g.:");
  console.error("  SELORA_KEY=sk-gw-... node scripts/register-selora.mjs");
  process.exit(1);
}

const DB_PATH = path.join(os.homedir(), ".9router/db/data.sqlite");
const NODE_ID = "openai-compatible-chat-selora";
const BASE_URL = "https://api.selora.lol/v1";
const PREFIX = "sl";
const MODELS = ["glm-5.3-flash"];

const db = new DatabaseSync(DB_PATH);
const now = new Date().toISOString();

db.exec("BEGIN");
try {
  // 1. provider node — standard openai-compatible chat transport
  db.prepare(
    `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt)
     VALUES(?, 'openai-compatible', 'Selora', ?, ?, ?)`
  ).run(NODE_ID, JSON.stringify({ prefix: PREFIX, apiType: "chat", baseUrl: BASE_URL }), now, now);

  // 2. connection — reuse the existing row's id so re-running never duplicates
  const existingConn = db.prepare(
    "SELECT id FROM providerConnections WHERE provider = ? LIMIT 1"
  ).get(NODE_ID);
  const connId = existingConn?.id || crypto.randomUUID();
  db.prepare(
    `INSERT OR REPLACE INTO providerConnections
       (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, 'apikey', 'Selora key 1', '', 1, 1, ?, ?, ?)`
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
        nodeName: "Selora",
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        connectionNoProxy: "",
      },
    }),
    now,
    now
  );

  // 3. custom models + aliases
  for (const m of MODELS) {
    const modelId = `${PREFIX}/${m}`;
    db.prepare(
      `INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`
    ).run(
      `${NODE_ID}|${modelId}|llm`,
      JSON.stringify({ providerAlias: PREFIX, id: modelId, type: "llm", name: m })
    );
    for (const alias of [modelId, m]) {
      db.prepare(
        `INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`
      ).run(alias, `${NODE_ID}/${modelId}`);
    }
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
  console.log("registered Selora");
  console.log("  node:      ", NODE_ID);
  console.log("  connection:", connId);
  console.log("  models:    ", MODELS.map((m) => `${PREFIX}/${m}`).join(", "));
} catch (err) {
  db.exec("ROLLBACK");
  console.error("failed:", err.message);
  process.exit(1);
}
db.close();
