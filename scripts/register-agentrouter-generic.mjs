/**
 * Register AgentRouter as an openai-compatible node in 9router.
 *
 * AgentRouter has three non-obvious requirements. Miss any one and every
 * request fails before it reaches a model:
 *
 *   1. User-Agent must start with `opencode/` (case-sensitive).
 *      Anything else — no UA, `node`, `axios/...`, `curl/...`, `9router/x`,
 *      `OpenCode/x`, `claude-cli/x` — gets 401 "unauthorized client detected".
 *      Node's fetch sends no UA by default, so this must be injected via
 *      settings.providerOverrides.
 *   2. apiType must be "responses". POST /v1/chat/completions is rejected with
 *      400 "模型 X 不支持 /v1/chat/completions 接口，请改用 /v1/responses".
 *   3. Only three models have a channel on the default group:
 *      gpt-5.6-sol, gpt-6-astra, gpt-6.1-sol. Everything else answers
 *      503 "当前分组 default 下对于模型 X 无可用渠道".
 *
 * A fourth item is needed for reasoning to work (not for connectivity):
 * thinkingFormat must be "openai-responses" so the effort lands in
 * `reasoning:{effort,summary}` instead of a top-level `reasoning_effort`
 * that the gateway ignores (every level then reads back as `max`).
 *
 * Usage:
 *   AGENTROUTER_KEY=sk-... node scripts/register-agentrouter-generic.mjs
 */
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const KEY = process.env.AGENTROUTER_KEY;
if (!KEY) {
  console.error("set AGENTROUTER_KEY first, e.g.:");
  console.error("  AGENTROUTER_KEY=sk-... node scripts/register-agentrouter-generic.mjs");
  process.exit(1);
}

const DB_PATH = path.join(os.homedir(), ".9router/db/data.sqlite");
const NODE_ID = "openai-compatible-chat-agentrouter";
const BASE_URL = "https://agentrouter.org/v1";
const PREFIX = "ar";
const MODELS = ["gpt-5.6-sol", "gpt-6-astra", "gpt-6.1-sol"];

const db = new DatabaseSync(DB_PATH);
const now = new Date().toISOString();

db.exec("BEGIN");
try {
  // 1. provider node — apiType "responses" is mandatory
  db.prepare(
    `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt)
     VALUES(?, 'openai-compatible', 'AgentRouter', ?, ?, ?)`
  ).run(NODE_ID, JSON.stringify({ prefix: PREFIX, apiType: "responses", baseUrl: BASE_URL }), now, now);

  // 2. connection — reuse the existing row's id so re-running never duplicates
  const existingConn = db.prepare(
    "SELECT id FROM providerConnections WHERE provider = ? LIMIT 1"
  ).get(NODE_ID);
  const connId = existingConn?.id || crypto.randomUUID();
  db.prepare(
    `INSERT OR REPLACE INTO providerConnections
       (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, 'apikey', 'AgentRouter key 1', '', 1, 1, ?, ?, ?)`
  ).run(
    connId,
    NODE_ID,
    JSON.stringify({
      apiKey: KEY,
      testStatus: "active",
      providerSpecificData: {
        prefix: PREFIX,
        apiType: "responses",
        baseUrl: BASE_URL,
        nodeName: "AgentRouter",
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

  // 4. rotation strategy
  const settingsRow = db.prepare("SELECT id, data FROM settings LIMIT 1").get();
  const settings = JSON.parse(settingsRow?.data || "{}");
  settings.providerStrategies = settings.providerStrategies || {};
  settings.providerStrategies[NODE_ID] = { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 20 };

  // 5. THE critical bit: inject the User-Agent the gateway requires
  settings.providerOverrides = settings.providerOverrides || {};
  settings.providerOverrides[NODE_ID] = { headers: { "User-Agent": "opencode/2.2.5" } };

  if (settingsRow) {
    db.prepare("UPDATE settings SET data = ? WHERE id = ?").run(JSON.stringify(settings), settingsRow.id);
  } else {
    db.prepare("INSERT INTO settings(id, data) VALUES('default', ?)").run(JSON.stringify(settings));
  }

  db.exec("COMMIT");
  console.log("registered AgentRouter");
  console.log("  node:      ", NODE_ID);
  console.log("  connection:", connId);
  console.log("  models:    ", MODELS.map((m) => `${PREFIX}/${m}`).join(", "));
  console.log("  UA override: opencode/2.2.5");
} catch (err) {
  db.exec("ROLLBACK");
  console.error("failed:", err.message);
  process.exit(1);
}
db.close();

console.log("\nNext: add the capability + thinking entries (see docs/agentrouter-setup.md),");
console.log("then rebuild: cd cli && NINEROUTER_CLI_APP_DIR=./app-next npm run build");
