/**
 * Restore per-provider rotation strategies that went missing from settings.
 *
 * The AgentRouter registration rewrote `settings.data` and dropped entries for
 * freeai and TokenJuice, and downgraded Abliteration from sticky 20 to 1.
 * Without an entry the provider falls back to the global default
 * (fallback, sticky 1), which for the high-key-count nodes means every request
 * lands on a different account and upstream prompt caching never warms.
 */
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const db = new DatabaseSync(path.join(os.homedir(), ".9router/db/data.sqlite"));

const EXPECTED = {
  "openai-compatible-chat-freeai": { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 20 },
  "openai-compatible-chat-74a85262-130a-44ec-a5ed-4c1ddd927c23": { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 20 },
  "openai-compatible-chat-abliteration": { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 20 },
  "openai-compatible-chat-agentrouter": { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 20 },
};

const row = db.prepare("SELECT id, data FROM settings LIMIT 1").get();
const settings = JSON.parse(row.data);
settings.providerStrategies = settings.providerStrategies || {};

for (const [node, want] of Object.entries(EXPECTED)) {
  const have = settings.providerStrategies[node];
  if (JSON.stringify(have) === JSON.stringify(want)) {
    console.log(`  ok        ${node}`);
    continue;
  }
  settings.providerStrategies[node] = want;
  console.log(`  restored  ${node}  (was ${JSON.stringify(have)})`);
}

db.prepare("UPDATE settings SET data = ? WHERE id = ?").run(JSON.stringify(settings), row.id);
db.close();
console.log("\nsettings written");
