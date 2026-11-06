/**
 * Register AgentRouter as an openai-compatible "responses" node in 9router.
 *
 * Upstream facts established by live probe (2026-11-06):
 *   - GET /v1/models  -> only 3 models, all supported_endpoint_types ["openai"]
 *   - POST /v1/chat/completions -> REJECTED for all GPT models ("use /v1/responses")
 *   - POST /v1/responses -> 200 for all 3, streaming + tool calling OK
 *   - reasoning effort: none|minimal|low|medium|high|xhigh|max all accepted (invalid -> 400)
 *   - max_output_tokens: 1000000 accepted (200 OK)
 *   - input: 880k tokens accepted; 950k paras timed out at gateway (not a clean reject)
 *   - vision: input_image accepted (200) but returned empty text -> NOT marked vision
 *   - Client gate: requests WITHOUT a User-Agent, or with node/axios/9router/Mozilla/OpenAI
 *     UAs, are rejected 401 "unauthorized client detected". Only opencode/* and
 *     claude-cli/* pass. Node fetch sends no UA, so 9router must inject one.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const DB_PATH = "/Users/ctp-itdev2/.9router/db/data.sqlite";
const NODE_ID = "openai-compatible-chat-agentrouter";
const PREFIX = "ar";
const BASE_URL = "https://agentrouter.org/v1";
const API_KEY = "sk-hi638TScirL7bMN5fgfzR5C40gMOz3Lj6LxLLNMHibA63xvx";
const CLIENT_UA = "opencode/2.2.5";

// Only models that actually resolve a channel. Docs also lists claude-opus-5,
// claude-opus-4-8, glm-5.3, deepseek-v4-flash but every one of those answers
// "当前分组 default 下对于模型 X 无可用渠道" on this key.
const MODELS = [
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { id: "gpt-6-astra", name: "GPT-6 Astra" },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
];

const db = new DatabaseSync(DB_PATH);
const now = new Date().toISOString();

// ── 1. provider node ────────────────────────────────────────────────────────
db.prepare(
  `INSERT OR REPLACE INTO providerNodes (id, type, name, data, createdAt, updatedAt)
   VALUES (?, ?, ?, ?, ?, ?)`
).run(NODE_ID, "openai-compatible", "AgentRouter",
  JSON.stringify({ prefix: PREFIX, apiType: "responses", baseUrl: BASE_URL }), now, now);
console.log(`node      : ${NODE_ID} (prefix=${PREFIX}, apiType=responses)`);

// ── 2. connection ───────────────────────────────────────────────────────────
const connId = randomUUID();
db.prepare(
  `INSERT OR REPLACE INTO providerConnections
     (id, provider, authType, name, priority, isActive, data, createdAt, updatedAt)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run(connId, NODE_ID, "apikey", "AgentRouter key 1", 1, 1,
  JSON.stringify({
    apiKey: API_KEY,
    testStatus: "active",
    providerSpecificData: {
      prefix: PREFIX, apiType: "responses", baseUrl: BASE_URL, nodeName: "AgentRouter",
      connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "",
    },
  }), now, now);
console.log(`connection: ${connId}`);

// ── 3. custom models + aliases ──────────────────────────────────────────────
const insModel = db.prepare(
  `INSERT OR REPLACE INTO kv (scope, key, value) VALUES ('customModels', ?, ?)`
);
const insAlias = db.prepare(
  `INSERT OR REPLACE INTO kv (scope, key, value) VALUES ('modelAliases', ?, ?)`
);
for (const m of MODELS) {
  insModel.run(`${NODE_ID}|${m.id}|llm`,
    JSON.stringify({ providerAlias: NODE_ID, id: m.id, type: "llm", name: m.name }));
  insAlias.run(`${PREFIX}/${m.id}`, `${NODE_ID}/${m.id}`);
  insAlias.run(m.id, `${NODE_ID}/${m.id}`);
  console.log(`model     : ${PREFIX}/${m.id}`);
}

// ── 4. settings: strategy + client-UA override ──────────────────────────────
const row = db.prepare("SELECT data FROM settings WHERE id = 1").get();
const settings = row ? JSON.parse(row.data) : {};
settings.providerStrategies = settings.providerStrategies || {};
settings.providerStrategies[NODE_ID] = { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 20 };
// The UA gate is the whole reason this provider needs an override: Node's fetch
// sends no User-Agent and AgentRouter answers 401 "unauthorized client detected".
settings.providerOverrides = settings.providerOverrides || {};
settings.providerOverrides[NODE_ID] = { headers: { "User-Agent": CLIENT_UA } };
db.prepare("INSERT OR REPLACE INTO settings (id, data) VALUES (1, ?)")
  .run(JSON.stringify(settings));
console.log(`strategy  : round-robin sticky 20`);
console.log(`override  : User-Agent: ${CLIENT_UA}`);

db.close();
console.log("\nOK — 1 node, 1 connection, 3 models, strategy + UA override set");
