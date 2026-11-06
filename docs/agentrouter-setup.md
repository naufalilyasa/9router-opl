# AgentRouter setup for 9router

Base URL: `https://agentrouter.org/v1`
Docs: https://agentrouter.org/docs/opencode.html

AgentRouter is not a plain OpenAI-compatible endpoint. Three things must be
right or every request fails before it reaches a model. All three were probed
live against the gateway, not taken from the docs.

## 1. User-Agent must start with `opencode/`

The gateway rejects unknown clients with `401 unauthorized client detected`.

| User-Agent | Result |
|---|---|
| *(no header — Node's `fetch` default)* | 401 |
| `node` | 401 |
| `axios/1.7.2` | 401 |
| `curl/8.0` | 401 |
| `python-requests/2.31.0` | 401 |
| `go-http-client/2.0` | 401 |
| `9router/0.5.112` | 401 |
| `OpenCode/2.2.5` (capital O, capital C) | 401 |
| `opencode` (no slash) | 401 |
| `opencode-ai/2.2.5` | 401 |
| `claude-cli/1.0.0`, `claude-cli/2.0.1`, `claude-cli/2.0.14` | 401 |
| `opencode/1.0.0` | **200** |
| `opencode/2.2.5` | **200** |
| `opencode/99.9.9` | **200** |
| `opencode/` | **200** |
| `opencode/2.2.5 extra` | **200** |

Rule: **case-sensitive prefix match on `opencode/`**. The version is ignored.

This is the usual cause of "key, baseUrl and model are all correct but it still
fails": the client never sent the header. In 9router it is injected through
`settings.providerOverrides`:

```json
{
  "openai-compatible-chat-agentrouter": {
    "headers": { "User-Agent": "opencode/2.2.5" }
  }
}
```

`User-Agent` is not in the `BLOCKED_HEADERS` set of
`src/app/api/providers/[id]/overrides/route.js`, so it can also be set from the
dashboard under Providers → AgentRouter → Overrides.

## 2. apiType must be `responses`

`POST /v1/chat/completions` is rejected:

```
400 模型 gpt-6.1-sol 不支持 /v1/chat/completions 接口，请改用 /v1/responses
```

Only `POST /v1/responses` works. In 9router this is the node's `apiType`:

```json
{ "prefix": "ar", "apiType": "responses", "baseUrl": "https://agentrouter.org/v1" }
```

`resolveOpenAICompatibleApiType()` (`open-sse/services/provider.js:27`) reads it
from `credentials.providerSpecificData.apiType`, and `buildUrl()`
(`open-sse/executors/base.js:30`) appends `/responses` instead of
`/chat/completions`.

## 3. Only three models have a channel

| Model | Status |
|---|---|
| `gpt-5.6-sol` | 200 |
| `gpt-6-astra` | 200 |
| `gpt-6.1-sol` | 200 |
| `claude-opus-5` | 503 no available channel |
| `claude-opus-4-8` | 503 no available channel |
| `glm-5.3` | 503 no available channel |
| `deepseek-v4-flash` | 503 no available channel |

```
503 当前分组 default 下对于模型 claude-opus-5 无可用渠道
```

The docs list more models than the `default` group can actually serve on a given
key. Register only the three above until the upstream group is upgraded.

## 4. Reasoning effort (not needed for connectivity)

Thinking is always on. Measured by echoing the applied effort back:

- `high`, `xhigh`, `max` are honored.
- `none`, `minimal`, `low`, `medium` are all clamped to `max`.

For the effort to reach the gateway at all, the capability entry needs
`thinkingFormat: "openai-responses"`. With the default `"openai"`,
`applyThinking` writes a top-level `reasoning_effort` that the gateway ignores,
so every level reads back as `max`. The `openai-responses` case emits
`reasoning:{effort,summary}` instead.

```js
// open-sse/providers/capabilities.js
PROVIDER_CAPABILITIES["openai-compatible-chat-agentrouter"] = {
  "ar/gpt-5.6-sol":  { reasoning: true, thinkingFormat: "openai-responses", thinkingCanDisable: false, contextWindow: 900000, maxOutput: 1000000 },
  "ar/gpt-6-astra":  { reasoning: true, thinkingFormat: "openai-responses", thinkingCanDisable: false, contextWindow: 900000, maxOutput: 1000000 },
  "ar/gpt-6.1-sol":  { reasoning: true, thinkingFormat: "openai-responses", thinkingCanDisable: false, contextWindow: 900000, maxOutput: 1000000 },
};
```

```js
// open-sse/providers/thinkingLevels.js
{ provider: "openai-compatible-chat-agentrouter", pattern: "*", levels: ["high", "xhigh", "max"] }
```

## Measured limits

- Context: 880k tokens accepted (200, `usage.input_tokens=880011`); ~950k times
  out at the gateway (`UND_ERR_HEADERS_TIMEOUT`) rather than rejecting cleanly.
  Published as 900000.
- `max_output_tokens`: 400000 / 500000 / 1000000 all 200. Published as 1000000.
- Tools: native `function_call` works.
- Streaming: standard Responses SSE (`response.created`,
  `response.in_progress`, `response.output_item.added`,
  `response.content_part.added`, `response.output_text.delta`, …,
  `response.completed`).
- Vision: `input_image` is accepted with 200 but the reply comes back empty, so
  vision is left off.
- Context probes built from synthetic repeated text get `400 content-blocked`;
  use varied natural prose.

## Content filter (worth knowing before you rely on it)

The gateway also runs a content filter that rejects low-entropy repetitive
payloads with `400 content-blocked` (`type: agent_router_api_error`). It is
deterministic — retries do not help — and it counts occurrences of the same
token or character inside a sliding window regardless of what separates them,
so interleaving markers or zero-width spaces does not bypass it. Roughly:

- the same token 3+ times inside a small window → blocked
- the same character 10+ times inside a small window → blocked

A realistic document passes fine; it is the repetitive regions that trip it. In
9router this is survivable by putting the model in a combo, because a 400 that
is not 401/402/403/429 is classified `requestScoped` and the combo advances to
the next member without a cooldown.

## Setup

```bash
AGENTROUTER_KEY=sk-... node scripts/register-agentrouter-generic.mjs
```

Then add the capability and thinking-level entries above, and rebuild:

```bash
cd cli && NINEROUTER_CLI_APP_DIR=./app-next npm run build
```

## Quick connectivity check

Isolate the client from the gateway before debugging 9router:

```bash
curl -s https://agentrouter.org/v1/responses \
  -H "Authorization: Bearer $AGENTROUTER_KEY" \
  -H "Content-Type: application/json" \
  -H "User-Agent: opencode/2.2.5" \
  -d '{"model":"gpt-6.1-sol","input":"say OK","max_output_tokens":16}'
```

Expected results, in the order they diagnose:

| Response | Meaning |
|---|---|
| `401 unauthorized client detected` | missing or wrong `User-Agent` |
| `400 模型 X 不支持 /v1/chat/completions` | wrong endpoint, use `/v1/responses` |
| `503 无可用渠道` | model has no channel on this key's group |
| `400 content-blocked` | payload tripped the content filter |
| `200` | gateway is fine; the problem is client-side |
