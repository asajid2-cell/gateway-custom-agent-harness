import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  OPENCODE_GO_ROUTES,
  OPENCODE_GO_MODEL_IDS,
  openCodeGoEffortLevels,
  openCodeGoEffortWireMap,
  isOpenCodeGoProtocol,
  anthropicToOpenCodeRequest,
  openCodeGoEndpoint,
  openCodeGoHeaders,
  redactSecret,
  relayOpenCodeStream,
  relayOpenCodeCollectedResponse,
  relayOpenCodeResponseByProtocol,
} from './opencode-go.mjs'
import {
  OPENCODE_ZEN_ROUTES,
  OPENCODE_ZEN_MODEL_IDS,
  openCodeZenEffortLevels,
  openCodeZenEffortWireMap,
  openCodeZenEndpoint,
  openCodeZenHeaders,
  isOpenCodeZenProtocol,
  ensureOpenCodeZenReadTool,
} from './opencode-zen.mjs'
import { GATEWAY_RELOAD_EXIT_CODE, isGatewayKeyEnvVar } from './gateway-keysafe.mjs'
import {
  QUOTA_TTL_MS,
  quotaKey,
  readQuotaThroughCache,
  readSharedQuota,
} from './quota-cache.mjs'
import { readCodexQuota, stopCodexQuota } from './codex-quota.mjs'
import {
  codexAccounts,
  currentCodexAccountName,
  readCodexAuth as readCodexAuthFromHome,
  setCurrentCodexAccount,
} from './codex-accounts.mjs'
import {
  anthropicAccounts,
  anthropicCredentialPath as anthropicAccountCredentialPath,
  currentAnthropicAccountName,
  findAnthropicAccount,
  readAnthropicAccount,
  setCurrentAnthropicAccount,
  writeAnthropicAccount,
} from './anthropic-accounts.mjs'
import {
  COMMANDCODE_MODEL_IDS,
  COMMANDCODE_ROUTES,
  commandCodeEffortLevels,
  commandCodeEndpoint,
  commandCodeGatewayId,
  commandCodeHeaders,
} from './commandcode.mjs'
import {
  MISTRAL_MODEL_IDS,
  MISTRAL_ROUTES,
  mistralEffortLevels,
  mistralEndpoint,
  mistralGatewayId,
  mistralRouteVariants,
  mistralHeaders,
  anthropicToMistralChat,
} from './mistral.mjs'
import {
  gatewayCatalogDrift,
  ANTHROPIC_EFFORT_LEVELS_BY_MODEL,
  ASTRA_EFFORT_LEVELS,
  GPT61_SOL_EFFORT_LEVELS,
  GPT_LUNA_EFFORT_LEVELS,
  GPT_SOL_EFFORT_LEVELS,
  GPT_TERRA_EFFORT_LEVELS,
  NATIVE_EFFORT_LEVELS,
} from './effort-capabilities.mjs'
import {
  appendRuntimeToolContract,
  ensureAgentIdentityPrefix,
  gatewayQuerySource,
  isCompactionRequest,
  isNativeSummaryRequest,
  rewriteGatewaySystemPrompt,
  RUNTIME_TOOL_CONTRACT,
  sanitizeLegacyCompactionContent,
  sanitizeStaleToolCapabilityContent,
} from './gateway-contract.mjs'

const HOST = '127.0.0.1'
const CODEX_ENDPOINT =
  process.env.CODEX_RESPONSES_URL || 'https://chatgpt.com/backend-api/codex/responses'
const DEEPSEEK_ENDPOINT =
  process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/anthropic/v1/messages'
// AMD Radeon Cloud speaks the Anthropic Messages protocol on /v1/messages with
// an x-api-key header, but is a separate provider with its own key and model
// namespace, so it gets its own backend rather than riding on DEEPSEEK_ENDPOINT.
const AMD_RADEON_ENDPOINT =
  process.env.AMD_RADEON_API_URL || 'https://developer.amd.com.cn/radeon/api/v1/messages'
// The user's own Anthropic subscription, forwarded verbatim to the first-party
// API. Credentials come from the Claude Code OAuth credential file rather than
// an env var, because the launcher strips ANTHROPIC_* from the environment it
// starts the Gateway in; ANTHROPIC_API_KEY stays supported as an explicit
// escape hatch for manual launches.
const ANTHROPIC_ENDPOINT =
  process.env.MODEL_GATEWAY_ANTHROPIC_URL ||
  'https://api.anthropic.com/v1/messages'
// Anthropic version-gates model availability by client user-agent: the fork's
// own MACRO.VERSION is 1.0.0-research, which the endpoint answers 400 "does not
// support" for these models. Measured 2026-09-29 - claude-cli/2.0.0 is refused,
// claude-cli/3.1.0 is served - so the Gateway pins a serving version instead of
// reporting the version it is built from.
const ANTHROPIC_USER_AGENT =
  process.env.MODEL_GATEWAY_ANTHROPIC_USER_AGENT ||
  'claude-cli/3.1.0 (external, cli)'
const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const ANTHROPIC_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const ANTHROPIC_OAUTH_SCOPES =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
const CODEX_REASONING_EFFORT =
  process.env.MODEL_GATEWAY_CODEX_REASONING_EFFORT || 'max'
const CODEX_SYSTEM_INSTRUCTION =
  process.env.MODEL_GATEWAY_CODEX_INSTRUCTION ||
  'You are a general-purpose GPT coding assistant. Follow the user instructions directly, use the provided tools when useful, and answer the user request. Do not adopt a product-specific persona or discuss the gateway.'
const MAX_BODY_SIZE = 50 * 1024 * 1024
const TRACE_MAX_BYTES = 10 * 1024 * 1024
const TRACE_MAX_EVENTS = 100_000

function durationEnvironment(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number of milliseconds`)
  }
  return Math.trunc(value)
}

const UPSTREAM_TIMEOUT_MS = durationEnvironment(
  'MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS',
  120_000,
)
const CONSUMER_TIMEOUT_MS = durationEnvironment(
  'MODEL_GATEWAY_CONSUMER_TIMEOUT_MS',
  180_000,
)
const UPSTREAM_RETRIES = integerEnvironment(
  'MODEL_GATEWAY_UPSTREAM_RETRIES',
  2,
)
const UPSTREAM_RETRY_BASE_MS = durationEnvironment(
  'MODEL_GATEWAY_UPSTREAM_RETRY_BASE_MS',
  250,
)
const UPSTREAM_RETRY_MAX_MS = durationEnvironment(
  'MODEL_GATEWAY_UPSTREAM_RETRY_MAX_MS',
  5_000,
)
const RETRY_ATTEMPT_TIMEOUT_MS = durationEnvironment(
  'MODEL_GATEWAY_RETRY_ATTEMPT_TIMEOUT_MS',
  30_000,
)
const RETRY_RESPONSE_TIMEOUT_MS = RETRY_ATTEMPT_TIMEOUT_MS > 0
  ? Math.min(UPSTREAM_TIMEOUT_MS, RETRY_ATTEMPT_TIMEOUT_MS)
  : UPSTREAM_TIMEOUT_MS
const RETRY_400 = process.env.MODEL_GATEWAY_RETRY_400 === '1'
const CODEX_TOOL_MODE = process.env.MODEL_GATEWAY_CODEX_TOOL_MODE || 'fallback'
const CODEX_PROMPT_CACHE_KEY_MODE =
  process.env.MODEL_GATEWAY_CODEX_PROMPT_CACHE_KEY_MODE || 'off'
const LOG_REQUEST_SHAPE = process.env.MODEL_GATEWAY_LOG_SHAPE === '1'
const LOG_EVENT_SHAPE = process.env.MODEL_GATEWAY_LOG_EVENT_SHAPE === '1'
// How long a Codex request may stream without producing caller-visible output
// before the relay starts telling the caller it is still being served, and how
// often to repeat that once it starts. A prompt that is answered, refused, or
// rejected is answered in milliseconds, so the delay keeps the pre-output
// status contract intact and only covers a provider that is genuinely working
// invisibly - reasoning for minutes before its answer.
const CODEX_LIVENESS_AFTER_MS = durationEnvironment(
  'MODEL_GATEWAY_LIVENESS_AFTER_MS',
  30_000,
)
const CODEX_LIVENESS_INTERVAL_MS = durationEnvironment(
  'MODEL_GATEWAY_LIVENESS_INTERVAL_MS',
  5_000,
)

if (!['fallback', 'balanced', 'compact'].includes(CODEX_TOOL_MODE)) {
  throw new Error(
    'MODEL_GATEWAY_CODEX_TOOL_MODE must be fallback, balanced, or compact',
  )
}
if (!['off', 'auto'].includes(CODEX_PROMPT_CACHE_KEY_MODE)) {
  throw new Error(
    'MODEL_GATEWAY_CODEX_PROMPT_CACHE_KEY_MODE must be off or auto',
  )
}

function integerEnvironment(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return value
}

// The models the user's own Anthropic subscription serves, newest first. Each
// one gets a visible `gateway-` route plus a hidden provider-native alias, so
// stale transcripts and direct callers that spell the first-party id still
// route.
//
// Effort is per model, not per generation: the provider rejects a level a model
// does not implement with a 400 naming that model's own accepted set, so one
// shared ladder sends values the next model over refuses. A 2026-09-30 sweep
// against the live endpoint - one deliberately invalid level per model - measured
// `xhigh` accepted by opus-5-5, sonnet-5-5, opus-5, sonnet-5, opus-4-8 and
// opus-4-7, rejected by opus-4-6 and sonnet-4-6 ("Supported levels: high, low,
// max, medium") and by opus-4-5-20251101 ("high, low, medium", which refuses
// `max` too). Each ladder is declared per model in the `gateway-claude-*`
// entries of scripts/effort-capabilities.json `gatewayAliases` and applied
// here, so the catalog stays the single declaration surface. The two
// 4.5-generation models reject the effort parameter outright and declare an
// empty ladder, which makes the gateway refuse a level locally rather than
// forward a request the provider rejects; the two fable models answer 429
// "Usage credits are required for this model" to every request, so their ladder
// could not be probed and stays at the CLI's conservative first-party default.
const ANTHROPIC_GATEWAY_MODELS = [
  ['gateway-claude-opus-5-5', 'claude-opus-5-5'],
  ['gateway-claude-sonnet-5-5', 'claude-sonnet-5-5'],
  ['gateway-claude-haiku-5-5', 'claude-haiku-5-5'],
  ['gateway-claude-fable-5-1', 'claude-fable-5-1'],
  ['gateway-claude-opus-5', 'claude-opus-5'],
  ['gateway-claude-sonnet-5', 'claude-sonnet-5'],
  ['gateway-claude-fable-5', 'claude-fable-5'],
  ['gateway-claude-opus-4-8', 'claude-opus-4-8'],
  ['gateway-claude-opus-4-7', 'claude-opus-4-7'],
  ['gateway-claude-sonnet-4-6', 'claude-sonnet-4-6'],
  ['gateway-claude-opus-4-6', 'claude-opus-4-6'],
  ['gateway-claude-opus-4-5-20251101', 'claude-opus-4-5-20251101'],
  ['gateway-claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'],
  ['gateway-claude-sonnet-4-5-20250929', 'claude-sonnet-4-5-20250929'],
]



const DEFAULT_MODELS = {
  // Provider-native IDs remain routable for old scripts and direct callers,
  // but are deliberately hidden from Gateway discovery and the /model picker.
  'gpt-5.6-luna': { backend: 'codex', upstream: 'gpt-5.6-luna', effortLevels: GPT_LUNA_EFFORT_LEVELS, hidden: true },
  'gpt-5.6-sol': { backend: 'codex', upstream: 'gpt-5.6-sol', effortLevels: GPT_SOL_EFFORT_LEVELS, hidden: true },
  'gpt-5.6-terra': { backend: 'codex', upstream: 'gpt-5.6-terra', effortLevels: GPT_TERRA_EFFORT_LEVELS, hidden: true },
  'gpt-6-astra': { backend: 'codex', upstream: 'gpt-6-astra', effortLevels: ASTRA_EFFORT_LEVELS, hidden: true },
  // The GPT-6 generation of the Luna and Sol line. All generations are served
  // by the provider at once, so each one keeps its own visible route below
  // rather than one id floating onto whichever generation is current. Sol now
  // has a point release as well; it has no Luna or Terra counterpart, and the
  // provider answers 400 for those names.
  'gpt-6-luna': { backend: 'codex', upstream: 'gpt-6-luna', effortLevels: GPT_LUNA_EFFORT_LEVELS, hidden: true },
  'gpt-6-sol': { backend: 'codex', upstream: 'gpt-6-sol', effortLevels: GPT_SOL_EFFORT_LEVELS, hidden: true },
  'gpt-6.1-sol': { backend: 'codex', upstream: 'gpt-6.1-sol', effortLevels: GPT61_SOL_EFFORT_LEVELS, hidden: true },
  'deepseek-flash': { backend: 'deepseek', upstream: 'deepseek-flash', effortLevels: ['low', 'high', 'max'], hidden: true },
  'deepseek-v4-flash': { backend: 'deepseek', upstream: 'deepseek-v4-flash', effortLevels: ['low', 'high', 'max'], hidden: true },
  'deepseek-v4-pro': { backend: 'deepseek', upstream: 'deepseek-v4-pro', effortLevels: ['low', 'high', 'max'], hidden: true },
  'deepseek-v4.1-flash': { backend: 'deepseek', upstream: 'deepseek-flash', effortLevels: ['low', 'high', 'max'], hidden: true },
  ...Object.fromEntries(
    OPENCODE_GO_MODEL_IDS.map(model => [
      `opencode-go/${model}`,
      {
        backend: 'opencode-go',
        upstream: model,
        protocol: OPENCODE_GO_ROUTES[model],
        effortLevels: openCodeGoEffortLevels(model),
        effortWireMap: openCodeGoEffortWireMap(model),
        hidden: true,
        ...(model === 'hy3' ? { supportsTools: false } : {}),
        ...(['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus'].includes(model)
          ? { supportsForcedToolChoice: false }
          : {}),
      },
    ]),
  ),
  // Gateway-visible aliases make the provider boundary explicit in /model and
  // /v1/models. The raw opencode-go/* IDs remain supported for direct callers.
  ...Object.fromEntries(
    OPENCODE_ZEN_MODEL_IDS.map(model => [
      `opencode-zen/${model}`,
      {
        backend: 'opencode-zen',
        upstream: model,
        protocol: OPENCODE_ZEN_ROUTES[model],
        effortLevels: openCodeZenEffortLevels(model),
        effortWireMap: openCodeZenEffortWireMap(model),
        hidden: true,
        ...(model === 'hy3-free' ? { supportsTools: false } : {}),
      },
    ]),
  ),
  ...Object.fromEntries(
    OPENCODE_ZEN_MODEL_IDS.map(model => [
      `gateway-opencode-${model}`,
      {
        backend: 'opencode-zen',
        upstream: model,
        protocol: OPENCODE_ZEN_ROUTES[model],
        effortLevels: openCodeZenEffortLevels(model),
        effortWireMap: openCodeZenEffortWireMap(model),
        ...(model === 'hy3-free' ? { supportsTools: false } : {}),
      },
    ]),
  ),
  ...Object.fromEntries(
    OPENCODE_GO_MODEL_IDS.map(model => [
      `gateway-opencode-${model}`,
      {
        backend: 'opencode-go',
        upstream: model,
        protocol: OPENCODE_GO_ROUTES[model],
        effortLevels: openCodeGoEffortLevels(model),
        effortWireMap: openCodeGoEffortWireMap(model),
        ...(model === 'hy3' ? { supportsTools: false } : {}),
        ...(['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus'].includes(model)
          ? { supportsForcedToolChoice: false }
          : {}),
      },
    ]),
  ),
  'gateway-gpt-6.1-sol': { backend: 'codex', upstream: 'gpt-6.1-sol', effortLevels: GPT61_SOL_EFFORT_LEVELS },
  'gateway-gpt-6-luna': { backend: 'codex', upstream: 'gpt-6-luna', effortLevels: GPT_LUNA_EFFORT_LEVELS },
  'gateway-gpt-luna': { backend: 'codex', upstream: 'gpt-5.6-luna', effortLevels: GPT_LUNA_EFFORT_LEVELS },
  'gateway-gpt-6-sol': { backend: 'codex', upstream: 'gpt-6-sol', effortLevels: GPT_SOL_EFFORT_LEVELS },
  'gateway-gpt-sol': { backend: 'codex', upstream: 'gpt-5.6-sol', effortLevels: GPT_SOL_EFFORT_LEVELS },
  'gateway-gpt-terra': { backend: 'codex', upstream: 'gpt-5.6-terra', effortLevels: GPT_TERRA_EFFORT_LEVELS },
  'gateway-gpt-astra': { backend: 'codex', upstream: 'gpt-6-astra', effortLevels: ASTRA_EFFORT_LEVELS },
  'gateway-ds-flash': { backend: 'deepseek', upstream: 'deepseek-v4-flash', effortLevels: ['low', 'high', 'max'] },
  'gateway-ds-pro': { backend: 'deepseek', upstream: 'deepseek-v4-pro', effortLevels: ['low', 'high', 'max'] },
  'gateway-ds-4.1-flash': { backend: 'deepseek', upstream: 'deepseek-flash', effortLevels: ['low', 'high', 'max'] },
  // AMD Radeon Cloud. `upstream` carries the provider's exact casing — the
  // Anthropic body is forwarded as-is, so a lowercased name would 404.
  // Effort levels below are probe-verified per model against the live Radeon
  // API (2026-09-16), not assumed: the router and each model disagree, so one
  // shared ladder would send values that 400. DeepSeek-V4-Flash accepts the
  // full enum; the two Qwen models accept only low/medium/xhigh and reject
  // high/max/minimal outright; MiniCPM5-2B accepts only low/medium/high.
  // Only the *-Vision-Exp / Qwen entries accept image input.
  'gateway-amd-ds-v4-flash': { backend: 'amd-radeon', upstream: 'DeepSeek-V4-Flash', effortLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  // Delisted upstream: the Radeon API answers /v1/models without it and returns
  // 404 model_not_found on every request. No effort ladder can be verified for a
  // model that does not answer, so this route advertises none.
  'gateway-amd-ds-v4-flash-vision-exp': { backend: 'amd-radeon', upstream: 'DeepSeek-V4-Flash-Vision-Exp', effortLevels: [] },
  'gateway-amd-qwen3.8-flash-next': { backend: 'amd-radeon', upstream: 'Qwen3.8-Flash-Next', effortLevels: ['low', 'medium', 'xhigh'] },
  'gateway-amd-qwen3.8-27b': { backend: 'amd-radeon', upstream: 'Qwen3.8-27B', effortLevels: ['low', 'medium', 'xhigh'] },
  'gateway-amd-minicpm5-2b': { backend: 'amd-radeon', upstream: 'MiniCPM5-2B', effortLevels: ['low', 'medium', 'high'] },
  ...Object.fromEntries(
    ANTHROPIC_GATEWAY_MODELS.flatMap(([id, upstream]) => {
      const effortLevels = ANTHROPIC_EFFORT_LEVELS_BY_MODEL[upstream] ?? []
      return [
        [id, { backend: 'anthropic', upstream, effortLevels }],
        [upstream, { backend: 'anthropic', upstream, effortLevels, hidden: true }],
      ]
    }),
  ),
  // Command Code. The provider fronts third-party models behind one Bearer key
  // and its OSS models only answer on /provider/v1/chat/completions (the
  // Anthropic endpoint rejects them by name), so this backend speaks chat
  // completions. `upstream` carries the provider's exact id — `deepseek/deepseek-v4.1-flash`,
  // `meituan/LongCat-2.0:free` — which is not derivable from the Gateway name.
  ...Object.fromEntries(
    COMMANDCODE_MODEL_IDS.map(model => [
      commandCodeGatewayId(model),
      {
        backend: 'commandcode',
        upstream: model,
        protocol: COMMANDCODE_ROUTES[model],
        effortLevels: commandCodeEffortLevels(model),
      },
    ]),
  ),
  // Mistral AI. Its public API is OpenAI-compatible chat completions behind one
  // Bearer key, and it also hosts third-party open-weight models. `upstream`
  // carries the provider-native id (`deepseek-v4-1-flash-1017`), which is not
  // derivable from the friendly Gateway name.
  ...Object.fromEntries(
    MISTRAL_MODEL_IDS.flatMap(model =>
      mistralRouteVariants(model).map(({ id, credential }) => [
        id,
        {
          backend: 'mistral',
          upstream: model,
          protocol: MISTRAL_ROUTES[model],
          effortLevels: mistralEffortLevels(model),
          mistralCredential: credential,
          ...(credential === 'auto' ? { hidden: true } : {}),
        },
      ]),
    ),
  ),
  // Legacy aliases for existing transcripts and direct callers. They remain
  // routable but hidden so a new session cannot accidentally select a Claude-
  // named route.
  'claude-gpt-luna': { backend: 'codex', upstream: 'gpt-5.6-luna', effortLevels: GPT_LUNA_EFFORT_LEVELS, hidden: true },
  'claude-gpt-sol': { backend: 'codex', upstream: 'gpt-5.6-sol', effortLevels: GPT_SOL_EFFORT_LEVELS, hidden: true },
  'claude-gpt-terra': { backend: 'codex', upstream: 'gpt-5.6-terra', effortLevels: GPT_TERRA_EFFORT_LEVELS, hidden: true },
  'claude-gpt-astra': { backend: 'codex', upstream: 'gpt-6-astra', effortLevels: ASTRA_EFFORT_LEVELS, hidden: true },
  'claude-ds-flash': { backend: 'deepseek', upstream: 'deepseek-v4-flash', effortLevels: ['low', 'high', 'max'], hidden: true },
  'claude-ds-pro': { backend: 'deepseek', upstream: 'deepseek-v4-pro', effortLevels: ['low', 'high', 'max'], hidden: true },
  'claude-ds-4.1-flash': { backend: 'deepseek', upstream: 'deepseek-flash', effortLevels: ['low', 'high', 'max'], hidden: true },
  ...Object.fromEntries(
    OPENCODE_ZEN_MODEL_IDS.map(model => [
      `claude-opencode-${model}`,
      {
        backend: 'opencode-zen',
        upstream: model,
        protocol: OPENCODE_ZEN_ROUTES[model],
        effortLevels: openCodeZenEffortLevels(model),
        effortWireMap: openCodeZenEffortWireMap(model),
        hidden: true,
        ...(model === 'hy3-free' ? { supportsTools: false } : {}),
      },
    ]),
  ),
  ...Object.fromEntries(
    OPENCODE_GO_MODEL_IDS.map(model => [
      `claude-opencode-${model}`,
      {
        backend: 'opencode-go',
        upstream: model,
        protocol: OPENCODE_GO_ROUTES[model],
        effortLevels: openCodeGoEffortLevels(model),
        effortWireMap: openCodeGoEffortWireMap(model),
        hidden: true,
        ...(model === 'hy3' ? { supportsTools: false } : {}),
        ...(['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus'].includes(model)
          ? { supportsForcedToolChoice: false }
          : {}),
      },
    ]),
  ),
}

function loadModels() {
  const raw = process.env.MODEL_GATEWAY_MODELS
  if (!raw) return { ...DEFAULT_MODELS }

  let override
  try {
    override = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `MODEL_GATEWAY_MODELS must be valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
    )
  }

  if (!override || Array.isArray(override) || typeof override !== 'object') {
    throw new Error('MODEL_GATEWAY_MODELS must be a JSON object')
  }

  const models = { ...DEFAULT_MODELS }
  for (const [name, value] of Object.entries(override)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`MODEL_GATEWAY_MODELS entry ${name} must be an object`)
    }
    if (
      value.backend !== 'codex' &&
      value.backend !== 'deepseek' &&
      value.backend !== 'amd-radeon' &&
      value.backend !== 'anthropic' &&
      value.backend !== 'opencode-go' &&
      value.backend !== 'opencode-zen' &&
      value.backend !== 'commandcode' &&
      value.backend !== 'mistral'
    ) {
      throw new Error(`MODEL_GATEWAY_MODELS entry ${name} has an invalid backend`)
    }
    if (typeof (value.upstream || name) !== 'string') {
      throw new Error(`MODEL_GATEWAY_MODELS entry ${name} needs a string upstream model`)
    }
    if (
      value.backend === 'opencode-go' &&
      !isOpenCodeGoProtocol(value.protocol)
    ) {
      throw new Error(`MODEL_GATEWAY_MODELS entry ${name} needs a valid OpenCode Go protocol`)
    }
    if (
      value.backend === 'opencode-zen' &&
      !isOpenCodeZenProtocol(value.protocol)
    ) {
      throw new Error(`MODEL_GATEWAY_MODELS entry ${name} needs a valid OpenCode Zen protocol`)
    }
    const previous = models[name]
    models[name] = {
      backend: value.backend,
      ...(typeof value.upstream === 'string' && value.upstream
        ? { upstream: value.upstream }
        : value.backend === 'codex' ||
            value.backend === 'opencode-go' ||
            value.backend === 'opencode-zen' ||
            value.backend === 'commandcode' ||
            value.backend === 'mistral'
          ? { upstream: name }
          : {}),
      ...(value.backend === 'opencode-go' || value.backend === 'opencode-zen'
        ? { protocol: value.protocol }
        : value.backend === 'commandcode' || value.backend === 'mistral'
          ? { protocol: 'chat-completions' }
          : {}),
      ...(value.backend === 'mistral' &&
      ['vibe', 'api', 'auto'].includes(value.mistralCredential)
        ? { mistralCredential: value.mistralCredential }
        : typeof previous?.mistralCredential === 'string'
          ? { mistralCredential: previous.mistralCredential }
          : {}),
      ...(Array.isArray(value.effortLevels)
        ? { effortLevels: value.effortLevels.filter(level => NATIVE_EFFORT_LEVELS.includes(level)) }
        : {}),
      ...(value.effortWireMap && typeof value.effortWireMap === 'object' && !Array.isArray(value.effortWireMap)
        ? { effortWireMap: { ...value.effortWireMap } }
        : {}),
      ...(typeof value.supportsTools === 'boolean'
        ? { supportsTools: value.supportsTools }
        : {}),
      ...(typeof value.supportsForcedToolChoice === 'boolean'
        ? { supportsForcedToolChoice: value.supportsForcedToolChoice }
        : {}),
      ...(typeof value.hidden === 'boolean'
        ? { hidden: value.hidden }
        : typeof previous?.hidden === 'boolean'
          ? { hidden: previous.hidden }
          : {}),
      ...(Array.isArray(value.fallback)
        ? { fallback: value.fallback.filter(hop => typeof hop === 'string' && hop.length > 0) }
        : {}),
    }
  }
  return models
}

const MODELS = loadModels()
const MODEL_NAMES = Object.keys(MODELS)
const DISCOVERABLE_MODEL_NAMES = MODEL_NAMES.filter(
  model => MODELS[model].hidden !== true,
)

// Ordered fallback chains. When a route fails before it has produced any output,
// the same request is re-issued against the next model in its chain. A chain is
// a plain array of registered Gateway model ids - the first hop that produces
// output wins - and it is bounded by its own length because the walk is a single
// pass over the list. Two ways to declare one: a global env map, or a `fallback`
// array on the model's own MODEL_GATEWAY_MODELS entry. The env map wins for any
// id it names. Everything is validated at startup so a typo fails the gateway
// rather than hiding until a request needs it.
function loadFallbacks(models) {
  const chains = new Map()
  const raw = process.env.MODEL_GATEWAY_FALLBACKS
  if (raw) {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(
        `MODEL_GATEWAY_FALLBACKS must be valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
      )
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('MODEL_GATEWAY_FALLBACKS must be a JSON object')
    }
    for (const [name, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) {
        throw new Error(`MODEL_GATEWAY_FALLBACKS entry ${name} must be an array of model ids`)
      }
      chains.set(name, value)
    }
  }
  for (const [name, model] of Object.entries(models)) {
    if (Array.isArray(model.fallback) && !chains.has(name)) chains.set(name, model.fallback)
  }

  for (const [name, chain] of chains) {
    if (!models[name]) {
      throw new Error(`MODEL_GATEWAY_FALLBACKS references unknown model ${name}`)
    }
    // The primary counts as already seen, so a chain can never name itself and
    // no hop can repeat - the guarantee a per-request visited-set would give,
    // enforced once instead of on every request.
    const seen = new Set([name])
    for (const hop of chain) {
      if (typeof hop !== 'string' || hop.length === 0) {
        throw new Error(`MODEL_GATEWAY_FALLBACKS entry ${name} must name model ids`)
      }
      if (!models[hop]) {
        throw new Error(`MODEL_GATEWAY_FALLBACKS entry ${name} references unknown model ${hop}`)
      }
      if (seen.has(hop)) {
        throw new Error(`MODEL_GATEWAY_FALLBACKS entry ${name} repeats model ${hop}`)
      }
      seen.add(hop)
    }
  }
  return chains
}

const MODEL_FALLBACKS = loadFallbacks(MODELS)

function fallbackChainFor(modelName) {
  const chain = MODEL_FALLBACKS.get(modelName)
  return Array.isArray(chain) ? chain : []
}

function validateGatewayCatalog() {
  const routedModelIds = Object.entries(DEFAULT_MODELS)
    .filter(([, route]) => route.hidden !== true)
    .map(([model]) => model)
  const drift = gatewayCatalogDrift(routedModelIds)
  if (
    drift.missingRoutes.length > 0 ||
    drift.missingCatalogEntries.length > 0 ||
    drift.unknownAliases.length > 0
  ) {
    throw new Error(
      `Gateway catalog/runtime drift: missing_routes=${drift.missingRoutes.join(',') || 'none'} ` +
      `missing_catalog_entries=${drift.missingCatalogEntries.join(',') || 'none'} ` +
      `unknown_aliases=${drift.unknownAliases.join(',') || 'none'}`,
    )
  }
}

validateGatewayCatalog()

function parsePort(raw, source) {
  if (raw == null || raw === '') return 0
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`Invalid ${source} port: ${raw}`)
  }
  return value
}

function resolvePort() {
  const args = process.argv.slice(2)
  const portEquals = args.find(value => value.startsWith('--port='))
  if (portEquals) return parsePort(portEquals.slice('--port='.length), '--port')

  const portIndex = args.indexOf('--port')
  if (portIndex >= 0) {
    if (portIndex + 1 >= args.length) throw new Error('--port needs a value')
    return parsePort(args[portIndex + 1], '--port')
  }

  return parsePort(process.env.MODEL_GATEWAY_PORT, 'MODEL_GATEWAY_PORT')
}

const PORT = resolvePort()

function json(res, status, body) {
  if (res.headersSent || res.destroyed || res.writableEnded) return
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function classifyGatewayError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  if (message.includes('timeout') || message.includes('aborted')) return 'timeout'
  if (
    message.includes('prompt is too long') ||
    message.includes('context window') ||
    message.includes('exceeds the context')
  ) return 'context-window'
  if (
    error instanceof SyntaxError ||
    message.includes('empty') ||
    message.includes('malformed') ||
    message.includes('unexpected token') ||
    message.includes('unexpected end of json')
  ) return 'malformed-response'
  if (message.includes('econnreset') || message.includes('connection reset')) return 'connection-reset'
  if (message.includes('http ')) return 'upstream-http-error'
  return 'upstream-error'
}

function createGatewayTrace({ model, backend, protocol }) {
  const requestStart = new Date().toISOString()
  const started = performance.now()
  const marks = {
    upstreamConnect: null,
    firstByte: null,
    firstOutput: null,
    completion: null,
    error: null,
  }
  let bytes = 0
  let events = 0
  const eventTypeCounts = new Map()
  let completionShape = null
  let errorClass = null
  let usage = null
  let finished = false

  const eventTypeSummary = () => {
    if (eventTypeCounts.size === 0) return 'none'
    return [...eventTypeCounts.entries()]
      .map(([type, count]) => `${safeLogValue(type).slice(0, 80)}:${count}`)
      .join(',')
  }

  const completionShapeSummary = () => {
    if (!completionShape) return {
      status: 'none',
      outputCount: -1,
      outputTypes: 'none',
    }
    return completionShape
  }

  const elapsed = () => Math.round(performance.now() - started)
  const mark = name => {
    if (marks[name] == null) marks[name] = elapsed()
  }

  return {
    markUpstreamConnect() { mark('upstreamConnect') },
    markFirstByte() { mark('firstByte') },
    markOutput() { mark('firstOutput') },
    markCompletion() { mark('completion') },
    markError(error) {
      mark('error')
      if (!errorClass) errorClass = classifyGatewayError(error)
    },
    clearError() {
      errorClass = null
      marks.error = null
    },
    markTimeout(message = 'Gateway request timed out') {
      const error = new Error(message)
      error.gatewayStatus = 504
      mark('error')
      errorClass = 'timeout'
    },
    addBytes(value) {
      const amount = Number(value)
      if (Number.isFinite(amount) && amount > 0) bytes = Math.min(TRACE_MAX_BYTES, bytes + Math.trunc(amount))
    },
    addEvent() {
      events = Math.min(TRACE_MAX_EVENTS, events + 1)
    },
    addEventType(type) {
      const key = typeof type === 'string' && type ? type : 'missing'
      if (!eventTypeCounts.has(key) && eventTypeCounts.size >= 64) return
      eventTypeCounts.set(key, (eventTypeCounts.get(key) || 0) + 1)
    },
    setCompletionShape(response) {
      const output = Array.isArray(response?.output) ? response.output : []
      completionShape = {
        status: safeLogValue(response?.status || 'missing'),
        outputCount: output.length,
        outputTypes: output.length === 0
          ? 'none'
          : output.map(item => safeLogValue(item?.type || 'missing').slice(0, 40)).join(',').slice(0, 240),
      }
    },
    setUsage(value) {
      usage = value && typeof value === 'object' ? value : null
    },
    eventTypeSummary,
    completionShapeSummary,
    finish(outcome, error = null, status = null) {
      if (finished) return
      if (error) this.markError(error)
      // Relays deliberately consume stream failures so they can emit an
      // Anthropic in-stream error after HTTP 200. Never let the outer handler
      // reclassify that response as a successful request.
      if (outcome === 'success' && errorClass) outcome = 'stream-error'
      finished = true
      if (outcome === 'success') this.markCompletion()
      if (process.env.MODEL_GATEWAY_LOG_TIMING !== '1') return
      const {
        inputTokens,
        cachedInputTokens,
        cacheWriteInputTokens,
      } = codexUsageTokenCounts(usage)
      const fields = [
        `route=${safeLogValue(backend)}`,
        `model=${safeLogValue(model)}`,
        `protocol=${safeLogValue(protocol || 'none')}`,
        `request_start=${requestStart}`,
        `upstream_connect_ms=${marks.upstreamConnect ?? -1}`,
        `first_byte_ms=${marks.firstByte ?? -1}`,
        `first_output_ms=${marks.firstOutput ?? -1}`,
        `completion_ms=${marks.completion ?? -1}`,
        `error_ms=${marks.error ?? -1}`,
        `bytes=${bytes}`,
        `events=${events}`,
        `input_count=${inputTokens}`,
        `cache_read_count=${cachedInputTokens}`,
        `cache_write_count=${cacheWriteInputTokens}`,
        `output_count=${nonNegativeInteger(usage?.output_tokens)}`,
        `status=${status == null ? -1 : status}`,
        `outcome=${safeLogValue(outcome)}`,
        `error_class=${safeLogValue(errorClass || 'none')}`,
        `provider_event_types=${safeLogValue(eventTypeSummary())}`,
        ...Object.entries(completionShapeSummary()).map(([key, value]) => `completion_${key}=${safeLogValue(value)}`),
      ]
      process.stderr.write(`model-gateway timing ${fields.join(' ')}\n`)
    },
    get finished() { return finished },
  }
}

function createRequestControl(req, res, trace, options = {}) {
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS
  const consumerTimeoutMs = options.consumerTimeoutMs ?? CONSUMER_TIMEOUT_MS
  const totalTimeoutMs = options.totalTimeoutMs ?? 0
  const controller = new AbortController()
  let closed = false
  let upstreamTimer = null
  let attemptController = null
  let attemptTimedOut = false
  let consumerTimer = null
  let totalTimer = null
  let streamErrorFinalizer = null
  const abort = (message, status = 504) => {
    if (closed) return
    closed = true
    const error = new Error(message)
    error.gatewayStatus = status
    if (status === 504) trace.markTimeout(message)
    else trace.markError(error)
    controller.abort(error)
    if (res.destroyed || res.writableEnded) return
    if (!res.headersSent) {
      anthropicError(res, status, message)
    } else {
      streamErrorFinalizer?.()
      finishAnthropicStreamWithError(res, error)
    }
  }
  const abortUpstream = (reason, status = 504) => {
    if (controller.signal.aborted) return
    const error = reason instanceof Error ? reason : new Error(String(reason || 'Gateway upstream request timed out'))
    error.gatewayStatus = status
    if (status === 504) trace.markTimeout(error.message)
    else trace.markError(error)
    controller.abort(error)
  }
  const armTotalTimeout = () => {
    if (totalTimer || totalTimeoutMs <= 0) return
    totalTimer = setTimeout(
      () => abort('Gateway total request timeout', 504),
      totalTimeoutMs,
    )
  }
  // The header deadline ends one upstream attempt, not the whole request.
  // Aborting here used to write the 504 itself, which made a stalled provider
  // fatal even when the pool held other accounts that could have answered:
  // every client retry then landed on the same stalled key. The deadline now
  // only kills the in-flight fetch, so the retry loop can move on; whoever
  // exhausts the attempts writes the reply.
  const beginUpstreamAttempt = (timeoutMs = upstreamTimeoutMs) => {
    if (upstreamTimer) {
      clearTimeout(upstreamTimer)
      upstreamTimer = null
    }
    attemptTimedOut = false
    if (upstreamTimeoutMs <= 0) return controller.signal
    const attempt = new AbortController()
    attemptController = attempt
    if (controller.signal.aborted) {
      attempt.abort(controller.signal.reason)
    } else {
      controller.signal.addEventListener('abort', () => attempt.abort(controller.signal.reason), { once: true })
    }
    const budget = timeoutMs > 0 ? timeoutMs : upstreamTimeoutMs
    upstreamTimer = setTimeout(() => {
      if (controller.signal.aborted) return
      attemptTimedOut = true
      trace.markTimeout('Gateway upstream request timed out')
      attempt.abort(new Error('Gateway upstream request timed out'))
    }, budget)
    return attempt.signal
  }
  const armConsumerTimeout = () => {
    if (consumerTimeoutMs <= 0 || consumerTimer) return
    consumerTimer = setTimeout(() => abort('Gateway consumer timeout', 504), consumerTimeoutMs)
  }

  const onRequestAborted = () => abort('Gateway request was aborted', 499)
  const onResponseClose = () => {
    // `close` commonly arrives with `destroyed === true`; that is exactly the
    // signal that the upstream must be cancelled. Normal completion has
    // `writableEnded === true` and is ignored.
    if (!res.writableEnded) abort('Gateway consumer disconnected', 499)
  }
  if (req && typeof req.once === 'function') req.once('aborted', onRequestAborted)
  if (res && typeof res.once === 'function') res.once('close', onResponseClose)

  return {
    signal: controller.signal,
    beginUpstreamAttempt,
    attemptTimedOut() { return attemptTimedOut },
    startUpstream() {
      armTotalTimeout()
      armConsumerTimeout()
    },
    upstreamConnected() {
      if (upstreamTimer) {
        clearTimeout(upstreamTimer)
        upstreamTimer = null
      }
      // Headers arrived, so this attempt is no longer waiting on them. A later
      // attempt (a relay retry or a pool failover) arms its own deadline.
      attemptTimedOut = false
    },
    abortUpstream,
    upstreamActivity() {
      if (closed || consumerTimeoutMs <= 0) return
      if (consumerTimer) clearTimeout(consumerTimer)
      consumerTimer = null
      armConsumerTimeout()
    },
    setStreamErrorFinalizer(finalizer) {
      streamErrorFinalizer = typeof finalizer === 'function' ? finalizer : null
    },
    statusFor(error) {
      return Number.isInteger(error?.gatewayStatus)
        ? error.gatewayStatus
        : controller.signal.aborted && trace.finished === false
          ? 504
          : 502
    },
    cleanup() {
      if (upstreamTimer) clearTimeout(upstreamTimer)
      if (consumerTimer) clearTimeout(consumerTimer)
      if (totalTimer) clearTimeout(totalTimer)
      if (req && typeof req.removeListener === 'function') req.removeListener('aborted', onRequestAborted)
      if (res && typeof res.removeListener === 'function') res.removeListener('close', onResponseClose)
    },
  }
}

function sendEvent(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
}

function finishAnthropicStreamWithError(res, error) {
  if (res.destroyed || res.writableEnded) return

  const message = error instanceof Error ? error.message : String(error || 'Upstream stream failed')
  try {
    sendEvent(res, 'error', {
      error: {
        type: 'api_error',
        message,
      },
    })
    res.end()
  } catch (writeError) {
    if (!res.destroyed && !res.writableEnded && typeof res.destroy === 'function') {
      res.destroy(writeError instanceof Error ? writeError : undefined)
    }
  }
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (typeof block === 'string') return block
      if (block?.type === 'text' || block?.type === 'input_text') {
        return block.text || ''
      }
      if (block?.type === 'image') return '[image]'
      if (block?.type === 'document') return documentMarker(block)
      if (block?.type === 'tool_result') return contentText(block.content)
      return ''
    })
    .join('')
}

function documentMarker(block) {
  const title =
    typeof block?.title === 'string' && block.title.trim()
      ? ` "${block.title.trim()}"`
      : ''
  return `[document${title} unavailable to the Codex Responses gateway]`
}

function anthropicImageUrl(block) {
  const source = block?.source
  if (!source || typeof source !== 'object') {
    throw new Error('Image block is missing its source')
  }

  if (source.type === 'url' && typeof source.url === 'string' && source.url) {
    return source.url
  }

  if (
    source.type === 'base64' &&
    typeof source.media_type === 'string' &&
    source.media_type &&
    typeof source.data === 'string' &&
    source.data
  ) {
    return `data:${source.media_type};base64,${source.data}`
  }

  throw new Error(`Unsupported Anthropic image source: ${String(source.type || 'missing')}`)
}

function serializeBlock(block) {
  try {
    return JSON.stringify(block)
  } catch {
    return String(block)
  }
}

function toolResultBlockText(block) {
  if (typeof block === 'string') return block
  if (block?.type === 'text' || block?.type === 'input_text') {
    return block.text || ''
  }
  if (block?.type === 'image') return '[image attachment]'
  if (block?.type === 'document') return documentMarker(block)
  if (block && typeof block === 'object') {
    return `[${String(block.type || 'tool output')}]\n${serializeBlock(block)}`
  }
  return String(block ?? '')
}

function codexToolResultOutput(content, isError = false) {
  if (typeof content === 'string') {
    return isError ? `[tool error]\n${content}` : content
  }
  if (!Array.isArray(content)) {
    const text = toolResultBlockText(content)
    return isError ? `[tool error]\n${text}` : text
  }

  const items = []
  for (const block of content) {
    if (block?.type === 'image') {
      items.push({ type: 'input_image', image_url: anthropicImageUrl(block) })
      continue
    }
    const text = toolResultBlockText(block)
    if (text) items.push({ type: 'input_text', text })
  }

  if (isError) items.unshift({ type: 'input_text', text: '[tool error]' })
  return items.some(item => item.type === 'input_image')
    ? items
    : items.map(item => item.text).join('')
}

function appendCodexFunctionCall(input, block) {
  const callId = block?.id || block?.tool_use_id
  if (!callId) return false

  input.push({
    type: 'function_call',
    call_id: callId,
    name: block.name || block.type || 'tool',
    arguments: JSON.stringify(block.input ?? {}),
  })
  return true
}

function appendCodexFunctionCallOutput(input, block) {
  const callId = block?.tool_use_id || block?.id
  if (!callId) return false

  input.push({
    type: 'function_call_output',
    call_id: callId,
    output: codexToolResultOutput(
      block.content ?? block.output ?? block.result ?? '',
      block.is_error === true,
    ),
  })
  return true
}

function systemText(system) {
  return contentText(system)
}

function rewriteCodexSystemPrompt(system, querySource) {
  // Keep the harness-provided operational context. Dropping it makes the
  // model lose cwd, tool, skill, plan, and environment instructions after a
  // long turn or compaction even though the tool schemas are still present.
  return rewriteGatewaySystemPrompt(
    system,
    CODEX_SYSTEM_INSTRUCTION,
    querySource,
  )
}

function metadataSessionId(metadata) {
  if (!metadata || typeof metadata !== 'object') return ''
  if (typeof metadata.session_id === 'string' && metadata.session_id.trim()) {
    return metadata.session_id.trim()
  }

  if (typeof metadata.user_id !== 'string') return ''
  try {
    const user = JSON.parse(metadata.user_id)
    return typeof user?.session_id === 'string' ? user.session_id.trim() : ''
  } catch {
    return ''
  }
}

function validHeaderValue(value) {
  return typeof value === 'string' && value.length > 0 && /^[\u0020-\u007e\u0080-\u00ff]+$/.test(value)
}

function upstreamSessionId(req, body) {
  const incoming = req?.headers?.['x-opencode-session']
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming
  const sessionId = validHeaderValue(candidate?.trim?.() || '')
    ? candidate.trim()
    : metadataSessionId(body?.metadata) || String(process.env.CLAUDE_CODE_SESSION_ID || '').trim()
  return validHeaderValue(sessionId) ? sessionId : ''
}

export function codexPromptCacheKeyForBody(
  body,
  mode = CODEX_PROMPT_CACHE_KEY_MODE,
) {
  if (mode !== 'auto') return null

  const sessionId =
    metadataSessionId(body?.metadata) ||
    String(process.env.CLAUDE_CODE_SESSION_ID || '').trim()
  if (!sessionId) return null

  // Keep the provider key opaque while making it stable for this Claude
  // session. The key namespaces a cache; it does not change the prompt.
  return `claude-code:${createHash('sha256')
    .update(sessionId)
    .digest('hex')
    .slice(0, 32)}`
}

function codexPromptCacheKey(body) {
  return codexPromptCacheKeyForBody(body)
}

function logFeatureSignals(body) {
  if (process.env.MODEL_GATEWAY_LOG_FEATURE_SIGNALS !== '1') return

  const system = systemText(body.system)
  const messages = (body.messages || [])
    .map(message => contentText(message.content))
    .join('\n')
  const source = messages.includes('Ultracode is on:')
    ? 'messages'
    : system.includes('Ultracode is on:')
      ? 'system'
      : 'none'
  const ultracode = source !== 'none'
    ? 'active'
    : messages.includes('keyword "ultracode"') ||
        system.includes('keyword "ultracode"')
      ? 'keyword'
      : 'absent'
  process.stderr.write(
    `model-gateway feature ultracode=${ultracode} source=${source}\n`,
  )
}

function appendAnthropicMessage(input, message) {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  const sanitizedContent = role === 'assistant'
    ? sanitizeStaleToolCapabilityContent(message.content)
    : sanitizeLegacyCompactionContent(message.content)
  const content =
    typeof sanitizedContent === 'string'
      ? [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: sanitizedContent }]
      : Array.isArray(sanitizedContent)
        ? sanitizedContent
        : []

  for (const block of content) {
    if (typeof block === 'string') {
      input.push({
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: block }],
      })
      continue
    }

    if (
      block?.type === 'text' ||
      block?.type === 'input_text' ||
      block?.type === 'output_text'
    ) {
      input.push({
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: block.text || '' }],
      })
      continue
    }

    if (block?.type === 'tool_use') {
      appendCodexFunctionCall(input, block)
      continue
    }

    if (block?.type === 'tool_result') {
      appendCodexFunctionCallOutput(input, block)
      continue
    }

    if (block?.type === 'server_tool_use' || block?.type === 'mcp_tool_use') {
      if (!appendCodexFunctionCall(input, block)) {
        input.push({
          role,
          content: [{ type: 'input_text', text: toolResultBlockText(block) }],
        })
      }
      continue
    }

    if (
      block?.type === 'server_tool_result' ||
      block?.type === 'advisor_tool_result' ||
      block?.type === 'mcp_tool_result' ||
      block?.type === 'web_search_tool_result' ||
      block?.type === 'web_fetch_tool_result' ||
      block?.type === 'code_execution_tool_result' ||
      block?.type === 'bash_code_execution_tool_result' ||
      block?.type === 'text_editor_code_execution_tool_result' ||
      block?.type === 'tool_search_tool_result'
    ) {
      if (!appendCodexFunctionCallOutput(input, block)) {
        input.push({
          role,
          content: [{ type: 'input_text', text: toolResultBlockText(block) }],
        })
      }
      continue
    }

    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      continue
    }

    if (block?.type === 'image') {
      input.push({
        role,
        content: [{ type: 'input_image', image_url: anthropicImageUrl(block) }],
      })
      continue
    }

    if (block?.type === 'document') {
      input.push({
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: documentMarker(block) }],
      })
      continue
    }

    if (block?.type === 'compaction') {
      input.push({
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: '[compaction boundary]' }],
      })
      continue
    }

    if (block?.type) {
      input.push({
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: toolResultBlockText(block) }],
      })
    }
  }
}

/**
 * Resolve the caller's requested effort against the route's own ladder.
 *
 * Returns the value to send, or `undefined` when no effort parameter may be
 * sent. `ultracode` is the one deliberate translation: it is a harness control
 * with no provider enum, so it resolves to the highest level the route does
 * implement. Any other value the route does not implement is a hard error —
 * the caller asked for a specific level and quietly sending a different one
 * (the previous `high` substitution) changed the request behind their back.
 */
export function resolveGatewayEffortForRoute(requested, route) {
  const levels = Array.isArray(route?.effortLevels)
    ? route.effortLevels
    : ['low', 'medium', 'high']
  if (requested === 'ultracode') {
    return levels.includes('ultra')
      ? 'ultra'
      : levels.includes('max')
        ? 'max'
        : levels.includes('high')
          ? 'high'
          : undefined
  }
  if (levels.includes(requested)) return requested
  const supported = levels.length > 0 ? levels.join(', ') : 'none'
  throw new UnsupportedEffortError(requested, supported)
}

export class UnsupportedEffortError extends Error {
  constructor(requested, supported) {
    super(
      `Effort ${JSON.stringify(requested)} is not supported by this model; supported effort values are: ${supported}. ` +
        'Pick one of these levels, or unset the effort to use the provider default.',
    )
    this.name = 'UnsupportedEffortError'
    this.requested = requested
    this.supported = supported
  }
}

export function normalizeGatewayEffort(body, route, querySource) {
  if (
    isNativeSummaryRequest(querySource) ||
    body?.thinking?.type === 'disabled'
  ) {
    const outputConfig = body.output_config
      ? { ...body.output_config }
      : undefined
    const reasoning = body.reasoning
      ? { ...body.reasoning }
      : undefined
    if (outputConfig) delete outputConfig.effort
    if (reasoning) delete reasoning.effort
    return {
      ...body,
      ...(outputConfig ? { output_config: outputConfig } : {}),
      ...(reasoning ? { reasoning } : {}),
    }
  }

  const requested = body?.output_config?.effort || body?.reasoning?.effort
  if (!requested) return body

  const effort = resolveGatewayEffortForRoute(requested, route)

  const outputConfig = body.output_config
    ? { ...body.output_config }
    : undefined
  if (outputConfig) {
    if (effort) outputConfig.effort = effort
    else delete outputConfig.effort
  }
  const reasoning = body.reasoning ? { ...body.reasoning } : undefined
  if (reasoning) {
    if (effort) reasoning.effort = effort
    else delete reasoning.effort
  }
  return {
    ...body,
    ...(outputConfig ? { output_config: outputConfig } : {}),
    ...(reasoning ? { reasoning } : {}),
  }
}

export function stripUnsupportedOpenCodeTools(body, route) {
  if (
    !['opencode-go', 'opencode-zen'].includes(route?.backend) ||
    route.supportsTools !== false ||
    !Array.isArray(body?.tools) ||
    body.tools.length === 0
  ) {
    return body
  }

  process.stderr.write(
    `model-gateway tools-disabled model=${safeLogValue(route.upstream || 'unknown')} reason=provider-capability\n`,
  )
  const next = { ...body }
  delete next.tools
  delete next.tool_choice
  return next
}

function isForcedToolChoice(choice) {
  return choice === 'any' ||
    choice === 'required' ||
    (choice && typeof choice === 'object' && choice.type === 'tool' && typeof choice.name === 'string')
}

export function stripUnsupportedOpenCodeToolChoice(body, route) {
  if (
    !['opencode-go', 'opencode-zen'].includes(route?.backend) ||
    route.supportsForcedToolChoice !== false ||
    !isForcedToolChoice(body?.tool_choice)
  ) {
    return body
  }

  process.stderr.write(
    `model-gateway tool-choice-disabled model=${safeLogValue(route.upstream || 'unknown')} reason=provider-capability\n`,
  )
  const next = { ...body }
  delete next.tool_choice
  return next
}

export function anthropicToCodex(body, upstreamModel, querySource) {
  logFeatureSignals(body)

  const input = []
  for (const message of body.messages || []) {
    appendAnthropicMessage(input, message)
  }

  const request = {
    model: upstreamModel,
    stream: body.stream === true,
    store: false,
    input,
    instructions: rewriteCodexSystemPrompt(body.system, querySource),
  }
  const promptCacheKey = codexPromptCacheKey(body)
  if (promptCacheKey) request.prompt_cache_key = promptCacheKey

  // Native harness compaction explicitly disables thinking. Do not invent a
  // provider reasoning request for that turn: the gateway is an adapter, not
  // a second compaction/effort policy.
  if (
    !isNativeSummaryRequest(querySource) &&
    body.thinking?.type !== 'disabled'
  ) {
    request.reasoning = {
      effort: body.output_config?.effort || body.reasoning?.effort || CODEX_REASONING_EFFORT,
      summary: 'detailed',
    }
  }

  if (body.max_tokens != null) request.max_output_tokens = body.max_tokens
  // Codex Responses rejects sampling controls for the GPT-5 reasoning route.
  // Claude's subagent requests may set these even when the parent request does
  // not, so forwarding them makes Agent calls fail while the parent succeeds.
  if (body.tools?.length) {
    const tools = body.tools.map(codexToolFromAnthropic).filter(Boolean)
    if (tools.length) request.tools = tools
  }

  if (body.tool_choice === 'auto' || body.tool_choice === 'none' || body.tool_choice === 'any') {
    request.tool_choice = body.tool_choice === 'any' ? 'required' : body.tool_choice
  } else if (body.tool_choice?.type === 'tool' && body.tool_choice.name) {
    request.tool_choice = { type: 'function', name: body.tool_choice.name }
  }

  process.stderr.write(
    'model-gateway codex effort=' +
    String(request.reasoning?.effort || 'disabled') +
    '\n',
  )
  return request
}

const CORE_TOOL_NAME_PATTERN =
  /^(read|write|edit|bash|glob|grep|skill|task|agent|todo|askuser)/i

// Anthropic's server-side tools have to be re-addressed to Codex's own hosted
// equivalents. Muse/experimental hosted types Codex has no counterpart for are
// dropped rather than translated into a function call nothing would execute.
const CODEX_HOSTED_WEB_SEARCH = { type: 'web_search' }
const CODEX_UNSUPPORTED_HOSTED_TYPES = new Set(['web_fetch', 'code_execution'])

/**
 * Translate one Anthropic tool declaration to its Codex form.
 *
 * The default is a client-executed function, which is right for every ordinary
 * tool. `web_search_20250305` is not ordinary: it is a *server-side* tool that
 * the provider runs itself. Passing it through as a function handed the model a
 * `web_search` function that nothing on either side ever executed, so the model
 * dutifully called it and the agent stalled with nothing to run. Codex has a
 * native `web_search` hosted tool - verified live: it returns real
 * `web_search_call` items with live queries and citations - so the declaration
 * maps onto that instead.
 */
function isUnsupportedHostedTool(tool) {
  if (typeof tool?.type !== 'string') return false
  for (const unsupported of CODEX_UNSUPPORTED_HOSTED_TYPES) {
    if (tool.type === unsupported || tool.type.startsWith(`${unsupported}_`)) {
      return true
    }
  }
  return false
}

// Hosted tools carry no `name`/`parameters`, so the schema-compaction helpers
// must leave them exactly as declared.
function isCodexHostedTool(tool) {
  return tool?.type === CODEX_HOSTED_WEB_SEARCH.type
}

function codexToolFromAnthropic(tool) {
  if (tool?.type === 'web_search_20250305') return { ...CODEX_HOSTED_WEB_SEARCH }
  if (isUnsupportedHostedTool(tool)) return null
  return {
    type: 'function',
    name: tool.name,
    description: tool.description || '',
    parameters: tool.input_schema || { type: 'object' },
  }
}

function slimCodexSchema(value) {
  if (Array.isArray(value)) return value.map(slimCodexSchema)
  if (!value || typeof value !== 'object') return value

  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'description' ||
      key === 'title' ||
      key === 'default' ||
      key === 'examples' ||
      key === 'example' ||
      key === '$comment'
    ) continue
    result[key] = slimCodexSchema(child)
  }
  return result
}

function contextFallbackRequests(request) {
  if (!Array.isArray(request.tools) || request.tools.length === 0) return []

  const slimTools = compactCodexTools(request)
  const coreTools = slimTools.filter(
    tool => isCodexHostedTool(tool) || CORE_TOOL_NAME_PATTERN.test(tool.name),
  )
  const variants = [{ ...request, tools: slimTools }]
  if (coreTools.length && coreTools.length < slimTools.length) {
    variants.push({ ...request, tools: coreTools })
  }
  return variants
}

function compactCodexTools(request) {
  return request.tools.map(tool =>
    isCodexHostedTool(tool)
      ? tool
      : {
          ...tool,
          description: '',
          parameters: slimCodexSchema(tool.parameters),
        },
  )
}

function boundedToolDescription(value, limit = 320) {
  const description = String(value || '').replace(/\s+/g, ' ').trim()
  return description.length > limit
    ? `${description.slice(0, Math.max(0, limit - 3))}...`
    : description
}

function safeCodexSchema(value) {
  if (Array.isArray(value)) return value.map(safeCodexSchema)
  if (!value || typeof value !== 'object') return value

  const result = {}
  for (const [key, child] of Object.entries(value)) {
    // These fields do not change the callable contract. Keep descriptions,
    // enums, required fields, defaults that matter to the model, and all
    // structural constraints intact so balanced mode remains quality-safe.
    if (
      key === 'title' ||
      key === 'examples' ||
      key === 'example' ||
      key === '$comment'
    ) continue
    result[key] = safeCodexSchema(child)
  }
  return result
}

function balancedCodexTools(request) {
  return request.tools.map(tool => {
    // The hosted declaration is a bare type tag with nothing to compact, and
    // rewriting it would make the compact variant differ from the fallback
    // variant, partitioning the Codex prompt cache.
    if (isCodexHostedTool(tool)) return tool
    const isCoreTool = CORE_TOOL_NAME_PATTERN.test(String(tool.name || ''))
    return {
      ...tool,
      // Built-in tools are the model's primary action vocabulary. Preserve
      // their complete descriptions and schemas. Optional/MCP tools still
      // receive bounded descriptions and metadata-only schema compression.
      description: isCoreTool
        ? String(tool.description || '')
        : boundedToolDescription(tool.description),
      parameters: isCoreTool
        ? tool.parameters
        : safeCodexSchema(tool.parameters),
    }
  })
}

export function codexRequestVariants(request, nativeCompaction = false) {
  // Native harness compaction deliberately carries the canonical tool catalog
  // for cache/protocol compatibility. Do not let a gateway-side schema mode or
  // context fallback rewrite that request and create a second compact policy.
  if (nativeCompaction) return [request]

  if (
    CODEX_TOOL_MODE === 'fallback' ||
    !Array.isArray(request.tools) ||
    request.tools.length === 0
  ) {
    return [request, ...contextFallbackRequests(request)]
  }

  const compressedTools = CODEX_TOOL_MODE === 'balanced'
    ? balancedCodexTools(request)
    : compactCodexTools(request)
  const compactRequest = {
    ...request,
    tools: compressedTools,
  }
  return [compactRequest, request, ...contextFallbackRequests(request)]
}

function codexRequestShape(request) {
  return [
    `input_items=${Array.isArray(request.input) ? request.input.length : 0}`,
    `tools=${Array.isArray(request.tools) ? request.tools.length : 0}`,
    `bytes=${Buffer.byteLength(JSON.stringify(request), 'utf8')}`,
  ].join(' ')
}

function fingerprint(value) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value) || '')
    .digest('hex')
    .slice(0, 16)
}

function providerPrefixMaterial(providerRequest) {
  return JSON.stringify({
    instructions: providerRequest?.instructions || '',
    tools: Array.isArray(providerRequest?.tools)
      ? providerRequest.tools
      : [],
  })
}

const cachePrefixObservations = new Map()

function cachePrefixState(body, model, querySource, prefixFingerprint) {
  const sessionId =
    metadataSessionId(body?.metadata) ||
    String(process.env.CLAUDE_CODE_SESSION_ID || '').trim()
  const observationKey = `${model}|${querySource || 'normal'}|${sessionId || 'anonymous'}`
  const previous = cachePrefixObservations.get(observationKey)
  cachePrefixObservations.set(observationKey, prefixFingerprint)
  if (!previous) return 'first'
  return previous === prefixFingerprint ? 'reuse' : 'changed'
}

async function readRawBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_SIZE) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readCodexAuth() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const auth = JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8'))
  const accessToken = auth?.tokens?.access_token
  const accountId = auth?.tokens?.account_id
  if (!accessToken || !accountId) {
    throw new Error('Codex ChatGPT auth is missing or incomplete; run codex login first')
  }
  return { accessToken, accountId }
}

// ---------------------------------------------------------------------------
// Codex accounts: CODEX_HOME is one login, so several subscriptions are several
// homes under ~/.codex-accounts. The pool mirrors the numbered key pools: a
// stable per-account number, a session pin or the global `current.txt`
// selection, and a rotation that moves past an account which cannot serve.
// A machine with no multi-account homes keeps the single-home behaviour.
// ---------------------------------------------------------------------------

/** Explicit per-session pins, as set by /login codex switch … session. */
const codexSessionSelections = new Map()
/** One live pool per session, so a failover sticks for that session. */
const codexPools = new Map()

async function codexLoadedAccounts() {
  try {
    return await codexAccounts()
  } catch {
    return []
  }
}

function codexPoolSignature(accounts) {
  // The home is part of the identity: two runs can use the same account names
  // under different roots, and a cached pool must not read the old files.
  return accounts.map(account => `${account.number}:${account.name}:${account.home}`).join(',')
}

function buildCodexPool(accounts, preferred) {
  let selected = preferred
  let lastServed = null
  const at = number => accounts.findIndex(account => account.number === number)
  const pool = {
    get accounts() { return accounts.map(account => ({ number: account.number, name: account.name })) },
    get numbers() { return accounts.map(account => account.number) },
    get size() { return accounts.length },
    get number() {
      const index = at(selected)
      return index < 0 ? accounts[0].number : accounts[index].number
    },
    get lastServed() { return lastServed },
    nameFor(number) { return accounts.find(account => account.number === number)?.name ?? null },
    advance() {
      const index = at(selected)
      if (index < 0) return
      selected = accounts[(index + 1) % accounts.length].number
    },
    select(number) {
      if (!accounts.some(account => account.number === number)) return false
      selected = number
      return true
    },
    markServed() { lastServed = pool.number },
    /**
     * The login of the selected account, rotating past a home whose auth.json
     * is missing or incomplete. Null when no loaded home is usable.
     */
    async auth() {
      for (let tries = 0; tries < accounts.length; tries += 1) {
        const account = accounts[at(pool.number)]
        if (!account) return null
        const auth = await readCodexAuthFromHome(account.home)
        if (auth) return auth
        pool.advance()
      }
      return null
    },
  }
  return pool
}

/** Single-home mode: the test harness turns the pool off for its scratch home. */
function codexPoolEnabled() {
  return process.env.CODEX_ACCOUNT_POOL !== 'off'
}

export async function codexRequestPool(sessionId) {
  if (!codexPoolEnabled()) return null
  const accounts = await codexLoadedAccounts()
  const key = sessionId || ''
  if (accounts.length === 0) {
    codexPools.delete(key)
    return null
  }
  const signature = codexPoolSignature(accounts)
  const cached = codexPools.get(key)
  if (cached?.signature === signature) return cached.pool
  // A pool is rebuilt only when the account set changes. Keep the position a
  // failover reached, then the session pin, then the global selection.
  const selectedName = await currentCodexAccountName()
  const selected = accounts.find(account => account.name === selectedName)
  const pinned = sessionId ? codexSessionSelections.get(sessionId) : undefined
  const carried = cached?.pool.number
  const preferred = Number.isSafeInteger(pinned) && accounts.some(account => account.number === pinned)
    ? pinned
    : accounts.some(account => account.number === carried)
      ? carried
      : selected?.number ?? accounts[0].number
  const pool = buildCodexPool(accounts, preferred)
  codexPools.set(key, { signature, pool })
  return pool
}

function anthropicError(res, status, message) {
  json(res, status, {
    type: 'error',
    error: { type: 'api_error', message },
  })
}

// A route that a fallback chain may leave behind. Every backend reports a route
// failure the same way - an `anthropicError` write, which is `writeHead` followed
// by `end` - so a response that has not sent headers and is asked to write a
// retryable status is holding exactly the failure a fallback exists for. This
// wrapper swallows that one write and records it; every other property and
// method delegates to the real response, and a 2xx (or any non-retryable status)
// passes straight through. Because nothing is written until the chain settles,
// the client still sees a single, normal response.
const FALLBACK_RETRYABLE = status => status === 429 || status >= 500

function createFallbackAttempt(res) {
  const state = { committed: false, suppressed: false, failure: null }
  const commit = () => { state.committed = true }
  const proxy = new Proxy(res, {
    get(target, property) {
      if (property === 'headersSent') return state.committed || target.headersSent
      if (property === 'writableEnded') return state.committed || target.writableEnded
      if (property === 'writeHead') {
        return (status, headers) => {
          const numeric = Number(status)
          if (!state.committed && FALLBACK_RETRYABLE(numeric)) {
            state.suppressed = true
            state.failure = { status: numeric, message: `upstream responded ${numeric}` }
            return proxy
          }
          commit()
          return target.writeHead(status, headers)
        }
      }
      if (property === 'write') {
        return (...args) => {
          commit()
          return target.write(...args)
        }
      }
      if (property === 'end') {
        return (...args) => {
          if (state.suppressed) return proxy
          commit()
          return target.end(...args)
        }
      }
      if (property === 'flushHeaders') {
        return (...args) => {
          commit()
          return target.flushHeaders(...args)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, property, value) {
      target[property] = value
      return true
    },
  })
  return { res: proxy, state }
}

function nonNegativeInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0
}

function codexUsageTokenCounts(usage) {
  const inputTokens = nonNegativeInteger(
    usage?.input_tokens ??
      (nonNegativeInteger(usage?.total_tokens) -
        nonNegativeInteger(usage?.output_tokens)),
  )
  const cachedInputTokens = Math.min(
    inputTokens,
    nonNegativeInteger(
      usage?.input_tokens_details?.cached_tokens ??
        usage?.cached_input_tokens ??
        usage?.cached_tokens ??
        usage?.cache_read_input_tokens,
    ),
  )
  const remainingInputTokens = Math.max(0, inputTokens - cachedInputTokens)
  const cacheWriteInputTokens = Math.min(
    remainingInputTokens,
    nonNegativeInteger(
      usage?.input_tokens_details?.cache_write_tokens ??
        usage?.input_tokens_details?.cache_creation_input_tokens ??
        usage?.cache_write_input_tokens ??
        usage?.cache_write_tokens ??
        usage?.cache_creation_input_tokens,
    ),
  )

  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    uncachedInputTokens: remainingInputTokens - cacheWriteInputTokens,
  }
}

/**
 * Codex reports cached input as a subset of input_tokens. Anthropic exposes
 * that subset separately, so subtract it before forwarding input_tokens or
 * Claude Code's context footer would count cached tokens twice.
 */
export function codexUsageToAnthropic(usage) {
  const {
    cachedInputTokens,
    cacheWriteInputTokens,
    uncachedInputTokens,
  } = codexUsageTokenCounts(usage)

  return {
    input_tokens: uncachedInputTokens,
    cache_creation_input_tokens: cacheWriteInputTokens,
    cache_read_input_tokens: cachedInputTokens,
    output_tokens: nonNegativeInteger(usage?.output_tokens),
  }
}

function codexResponseFailure(response) {
  const detail = [
    response?.error?.message,
    response?.response?.error?.message,
    response?.status_details?.reason,
  ]
    .find(value => typeof value === 'string' && value)
  const message = String(detail || '')
  if (isContextWindowFailure(new Error(message))) {
    throw new Error('Prompt is too long: Codex context window exceeded')
  }
  throw new Error('Codex response failed')
}

function codexOutputText(item) {
  if (item?.type !== 'message' || !Array.isArray(item.content)) return ''
  return item.content
    .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
}

function codexEventShape(event) {
  if (LOG_EVENT_SHAPE !== true) return
  const type = event?.type
  if (![
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
    'response.failed',
  ].includes(type)) return

  const keys = value => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort().join(',') || 'none'
    : 'none'
  const types = value => Array.isArray(value)
    ? value.map(item => safeLogValue(item?.type || typeof item).slice(0, 40)).join(',') || 'none'
    : 'none'
  const text = value => typeof value === 'string'
    ? `string:${Buffer.byteLength(value, 'utf8')}`
    : safeLogValue(value == null ? 'missing' : typeof value)
  const item = event?.item
  const response = event?.response
  const fields = [
    `type=${safeLogValue(type)}`,
    `keys=${keys(event)}`,
    `response_keys=${keys(response)}`,
    `response_output_count=${Array.isArray(response?.output) ? response.output.length : -1}`,
    `response_output_types=${types(response?.output)}`,
    `item_keys=${keys(item)}`,
    `item_content_count=${Array.isArray(item?.content) ? item.content.length : -1}`,
    `item_content_types=${types(item?.content)}`,
    `text=${text(event?.text)}`,
    `delta=${text(event?.delta)}`,
    `part_keys=${keys(event?.part)}`,
    `part_text=${text(event?.part?.text)}`,
    `output_text_keys=${keys(event?.output_text)}`,
    `output_text_text=${text(event?.output_text?.text)}`,
    `content_keys=${keys(event?.content)}`,
    `content_text=${text(event?.content?.text)}`,
    `content_part_keys=${keys(event?.content_part)}`,
    `content_part_text=${text(event?.content_part?.text)}`,
    `output_item_keys=${keys(event?.output_item)}`,
  ]
  process.stderr.write(`model-gateway event-shape ${fields.join(' ')}\n`)
}

// Codex splits its output by `phase`. Only the final answer is user-facing;
// the pre-search commentary would otherwise be emitted as ordinary assistant
// text alongside the answer that supersedes it.
function codexIsInterimMessage(item) {
  return typeof item?.phase === 'string' && item.phase !== 'final_answer'
}

// Codex reports a hosted web search as an output item whose `action` carries
// the queries it ran. The merged multi-query form is what Claude's per-search
// result shape expects, and the result URLs arrive only inside the final
// answer text (the `annotations` array is always empty), so the text is passed
// through verbatim and rendered as-is.
function codexWebSearchQueries(item) {
  const action = item?.action
  if (!action || typeof action !== 'object') return []
  if (Array.isArray(action.queries)) {
    return action.queries.filter(q => typeof q === 'string' && q.length > 0)
  }
  return typeof action.query === 'string' && action.query.length > 0
    ? [action.query]
    : []
}

function codexWebSearchResult(item) {
  const queries = codexWebSearchQueries(item)
  const query = queries.join(' ')
  return {
    contentBlock: {
      type: 'server_tool_use',
      id: item.id,
      name: 'web_search',
      input: { query },
    },
    resultBlock: {
      type: 'web_search_tool_result',
      tool_use_id: item.id,
      content: queries.length
        ? queries.map(q => ({ type: 'web_search_result', title: q, url: '' }))
        : [],
    },
  }
}

function codexOutputMessageFromEvent(event) {
  if (event?.type === 'response.output_text.done') {
    if (typeof event.text === 'string') return event.text
    if (typeof event.part?.text === 'string') return event.part.text
    if (typeof event.content?.text === 'string') return event.content.text
  }
  if (event?.type === 'response.output_item.done') {
    return codexOutputText(event.item)
  }
  return ''
}

function codexOutputMessageFromResponse(response) {
  if (!response || typeof response !== 'object') return ''
  if (typeof response.output_text === 'string') return response.output_text
  if (typeof response.text === 'string') return response.text
  if (Array.isArray(response.content)) {
    const text = response.content
      .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('')
    if (text) return text
  }
  return ''
}

function parseCodexFunctionArguments(argumentsValue) {
  if (argumentsValue == null || argumentsValue === '') return {}
  if (typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) {
    return argumentsValue
  }
  if (typeof argumentsValue !== 'string') {
    throw new Error('Codex returned malformed function-call arguments')
  }
  let parsed
  try {
    parsed = JSON.parse(argumentsValue)
  } catch {
    throw new Error('Codex returned malformed function-call arguments')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Codex returned malformed function-call arguments')
  }
  return parsed
}

/**
 * Convert one completed non-streaming Codex Responses object to an Anthropic
 * Messages response. This is deliberately separate from the SSE relay: the
 * Anthropic SDK's streaming fallback requires JSON, not a 200 SSE response.
 */
export function codexResponseToAnthropic(response, model) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Codex returned malformed JSON')
  }
  if (response.error || response.response?.error) codexResponseFailure(response)
  if (response.status && response.status !== 'completed') {
    const reason = response.incomplete_details?.reason || response.status
    if (String(reason).toLowerCase().includes('max')) {
      throw new Error('Codex response reached the output token limit')
    }
    throw new Error('Codex response did not complete')
  }

  const content = []
  let hasToolUse = false
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (item?.type === 'message') {
      // Pre-search commentary is dropped: the final answer supersedes it, and
      // both would otherwise appear as separate assistant text blocks.
      if (codexIsInterimMessage(item)) continue
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === 'output_text' && typeof part.text === 'string' && part.text) {
          content.push({ type: 'text', text: part.text })
        }
      }
    } else if (item?.type === 'function_call') {
      if (!item.call_id && !item.id) throw new Error('Codex returned a function call without an id')
      if (!item.name) throw new Error('Codex returned a function call without a name')
      content.push({
        type: 'tool_use',
        id: item.call_id || item.id,
        name: item.name,
        input: parseCodexFunctionArguments(item.arguments),
      })
      hasToolUse = true
    } else if (item?.type === 'web_search_call') {
      // A hosted search is server-side, so it is not a tool the caller must run
      // and must not set stop_reason=tool_use - the turn is still the model's.
      const { contentBlock, resultBlock } = codexWebSearchResult(item)
      content.push(contentBlock, resultBlock)
    }
  }

  if (!content.length) throw new Error('Codex returned an empty or malformed response')

  return {
    id: typeof response.id === 'string' && response.id ? response.id : `msg_${randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: codexUsageToAnthropic(response.usage),
  }
}

export async function relayCodexResponse(
  res,
  upstream,
  model,
  trace = null,
  forceStream = false,
  control = null,
  options = {},
) {
  let reader = null
  try {
    let response
    const contentType = upstream.headers?.get?.('content-type') || ''
    if (forceStream || contentType.includes('text/event-stream')) {
      reader = upstream.body?.getReader()
      if (!reader) throw new Error('Codex returned an empty response body')
      const decoder = new TextDecoder()
      let buffer = ''
      let completed = null
      let text = ''
      const toolCalls = new Map()
      const webSearches = new Map()
      let messagePhase = null
      const handleEvent = event => {
        codexEventShape(event)
        if (
          event.type === 'response.output_item.added' &&
          event.item?.type === 'message'
        ) {
          messagePhase = event.item.phase ?? null
          return
        }
        if (event.type === 'response.output_text.delta') {
          if (codexIsInterimMessage({ phase: messagePhase })) return
          const delta = typeof event.delta === 'string'
            ? event.delta
            : typeof event.part?.text === 'string'
              ? event.part.text
              : ''
          text += delta
          return
        }
        if (event.type === 'response.output_text.done') {
          if (!text && !codexIsInterimMessage({ phase: messagePhase })) {
            text = codexOutputMessageFromEvent(event)
          }
          return
        }
        if (
          event.type === 'response.output_item.done' &&
          event.item?.type === 'web_search_call'
        ) {
          webSearches.set(event.item.id, event.item)
          return
        }
        if (event.type === 'response.output_item.done' && event.item?.type === 'message') {
          if (!text && !codexIsInterimMessage(event.item)) {
            text = codexOutputMessageFromEvent(event)
          }
          return
        }
        if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
          const item = {
            type: 'function_call',
            id: event.item.id,
            call_id: event.item.call_id,
            name: event.item.name,
            arguments: '',
          }
          toolCalls.set(item.call_id || item.id, item)
          return
        }
        if (event.type === 'response.function_call_arguments.delta') {
          const key = event.call_id || event.item?.call_id || event.item?.id
          const item = toolCalls.get(key)
          if (item) item.arguments += typeof event.delta === 'string' ? event.delta : ''
          return
        }
        if (event.type === 'response.failed') {
          throw new Error(event.response?.error?.message || 'Codex response failed')
        }
        if (event.type === 'response.completed') {
          completed = event.response || event
        }
      }
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        control?.upstreamActivity?.()
        trace?.markFirstByte()
        trace?.addBytes(value?.byteLength || 0)
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (!data || data === '[DONE]') continue
          trace?.addEvent()
          const event = JSON.parse(data)
          trace?.addEventType?.(event?.type)
          handleEvent(event)
          if (completed) {
            trace?.setCompletionShape?.(completed)
            break
          }
        }
        if (completed) {
          await cancelUpstreamReader(reader, upstream)
          break
        }
      }
      if (!completed && buffer.startsWith('data: ')) {
        const data = buffer.slice(6)
        if (data && data !== '[DONE]') {
          trace?.addEvent()
          const event = JSON.parse(data)
          trace?.addEventType?.(event?.type)
          handleEvent(event)
          if (completed) trace?.setCompletionShape?.(completed)
        }
      }
      if (!completed) throw new Error('Codex stream ended before response.completed')
      if (!completed.output?.length && (text || toolCalls.size || webSearches.size)) {
        completed = {
          ...completed,
          output: [
            ...(text ? [{ type: 'message', content: [{ type: 'output_text', text }] }] : []),
            ...toolCalls.values(),
            ...webSearches.values(),
          ],
        }
      }
      response = completed
    } else {
      const raw = await upstream.text()
      trace?.markFirstByte()
      trace?.addBytes(Buffer.byteLength(raw, 'utf8'))
      trace?.addEvent()
      response = JSON.parse(raw)
      trace?.setCompletionShape?.(response)
      if (Array.isArray(response?.output)) {
        for (const item of response.output) trace?.addEventType?.(`output.${item?.type || 'missing'}`)
      }
    }
    trace?.setUsage?.(response?.usage)
    const message = codexResponseToAnthropic(response, model)
    trace?.markOutput()
    trace?.markCompletion()
    json(res, 200, message)
    return true
  } catch (error) {
    trace?.markError(error)
    if (options.throwPreOutput) {
      await cancelUpstreamReader(reader, upstream)
      throw error
    }
    if (isContextWindowFailure(error)) {
      finishAnthropicPromptTooLongError(res, error)
    } else {
      anthropicError(res, 502, errorMessage(error))
    }
    return false
  } finally {
    reader?.releaseLock?.()
  }
}

function writeMessageStart(res, model) {
  const messageId = `msg_${randomUUID().replaceAll('-', '')}`
  sendEvent(res, 'message_start', {
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
  })
  sendEvent(res, 'ping', {})
}

function startAnthropicStream(res, model) {
  if (res.headersSent) return
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  writeMessageStart(res, model)
}

function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error || 'Upstream stream failed')
}

function safeUpstreamError(status, provider) {
  return `${provider} returned HTTP ${status}`
}

export async function safeUpstreamResponseError(response, provider, secret = '', options = {}) {
  return safeUpstreamResponseErrorBounded(response, provider, secret, options)
}

async function readResponseCloneText(response, {
  signal = null,
  timeoutMs = 0,
  onTimeout = null,
} = {}) {
  const clone = response.clone()
  const textPromise = clone.text()
  // A timed-out race leaves the body promise pending until cancellation or
  // the provider closes it. Attach a rejection handler so that cleanup does
  // not create an unhandled rejection.
  textPromise.catch(() => {})
  if ((!signal || typeof signal.addEventListener !== 'function') && timeoutMs <= 0) {
    return textPromise
  }

  let timer = null
  let abortHandler = null
  let timedOut = false
  try {
    const races = [textPromise]
    if (signal && typeof signal.addEventListener === 'function') {
      races.push(new Promise((_, reject) => {
        abortHandler = () => reject(signal.reason || new Error('Gateway request aborted'))
        if (signal.aborted) abortHandler()
        else signal.addEventListener('abort', abortHandler, { once: true })
      }))
    }
    if (timeoutMs > 0) {
      races.push(new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          const error = new Error('Gateway upstream response body timed out')
          error.gatewayStatus = 504
          onTimeout?.(error)
          reject(error)
        }, timeoutMs)
      }))
    }
    return await Promise.race(races)
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
    if (timedOut) await clone.body?.cancel?.().catch(() => {})
  }
}

async function safeUpstreamResponseErrorBounded(
  response,
  provider,
  secret = '',
  options = {},
) {
  let detail = ''
  try {
    const raw = await readResponseCloneText(response, options)
    if (raw) {
      const parsed = JSON.parse(raw)
      const candidates = []
      const collect = value => {
        if (typeof value === 'string') {
          const text = value.trim()
          if (text) candidates.push(text)
        } else if (Array.isArray(value)) {
          for (const item of value) collect(item)
        } else if (value && typeof value === 'object') {
          for (const item of Object.values(value)) collect(item)
        }
      }
      collect(parsed?.error?.message ?? parsed?.message ?? parsed)
      detail = candidates
        .sort((a, b) => a.length - b.length)
        .find(value => value.length <= 500) || ''
    }
  } catch (error) {
    if (options?.signal?.aborted) {
      throw options.signal.reason || error
    }
    // Keep the generic status when the provider body is not safe JSON.
  }
  const suffix = detail ? `: ${redactSecret(detail, secret)}` : ''
  return `${provider} returned HTTP ${response.status}${suffix}`
}

async function cancelUpstreamReader(reader, upstream) {
  if (reader && typeof reader.cancel === 'function') {
    try {
      await reader.cancel()
      return
    } catch {
      // Fall through to the body-level cancellation attempt.
    }
  }
  await Promise.resolve(upstream?.body?.cancel?.()).catch(() => {})
}

function retryAfterMs(response) {
  const value = response?.headers?.get?.('retry-after')
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(UPSTREAM_RETRY_MAX_MS, Math.round(seconds * 1000))
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return Math.max(0, Math.min(UPSTREAM_RETRY_MAX_MS, timestamp - Date.now()))
}

function retryableStatus(status) {
  return (RETRY_400 && status === 400) ||
    status === 402 ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
}

// A 400 body carries the provider's own words for a transient or quota
// condition. Only providers whose gateway-side pool can rotate keys are
// inspected this way; a genuinely invalid request (unknown model, bad body) is
// still surfaced rather than retried.
function providerHasRotatingBodyMarkers(provider) {
  const name = String(provider).toLowerCase()
  return name.includes('opencode') || name.includes('commandcode') || name.includes('command code') ||
    name.includes('mistral') || name.includes('codex')
}

// Wording that means the key cannot serve, not that the request is wrong. Kept
// specific on purpose: a broad token like "out of" false-positives on ordinary
// validation errors. "credit" covers "credits"/"insufficient credits".
const QUOTA_BODY_MARKERS = [
  'usage limit',
  'quota',
  'insufficient',
  'credit',
  'exceed',
  'balance',
  'billing',
  'payment required',
  'rate limit',
  'capacity',
  'exhausted',
  'temporarily unavailable',
  'try again',
  'overloaded',
]

// A timeout is transient but not a quota problem, so it retries but does not
// count as a credential failure.
const TRANSIENT_BODY_MARKERS = [...QUOTA_BODY_MARKERS, 'timeout']

async function retryableResponse(provider, response, control = null) {
  if (retryableStatus(response.status)) return true
  if (response.status !== 400 || !providerHasRotatingBodyMarkers(provider)) {
    return false
  }

  try {
    const body = (await readResponseCloneText(response, {
      signal: control?.signal,
      timeoutMs: RETRY_RESPONSE_TIMEOUT_MS,
      onTimeout: error => control?.abortUpstream?.(error),
    })).toLowerCase()
    return TRANSIENT_BODY_MARKERS.some(marker => body.includes(marker))
  } catch {
    if (control?.signal?.aborted) throw control.signal.reason
    return false
  }
}

/**
 * Classify a reply as "this credential cannot serve" and say why.
 *
 * Kept separate from the rotation decision because the two are not the same
 * fact. Rotation needs more than one key; the health bit does not, and a
 * single-key provider whose only key just reported exhausted credits is exactly
 * the case a pre-open gate has to be able to see.
 */
function credentialFailureState(marker, label = marker) {
  // `marker` decides the state; `label` names the wording in the reason. They
  // differ only for the most useful case: the provider's literal phrase is
  // "insufficient credits", and recording just "insufficient" drops the noun a
  // reader needs.
  const normalized = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return marker === 'privacy settings'
    ? { state: 'unauthorized', reason: 'http_400_privacy_settings' }
    : { state: 'exhausted', reason: `http_400_${normalized}` }
}

// A credential failure is a reply that means "this key cannot serve" rather than
// "this request is wrong". 401/403 say so directly; 402 is payment/quota
// exhaustion; and a 400 carrying quota wording does too. Any of them must move
// the pool to the next key when more than one is loaded.
async function credentialFailure(provider, response, credentials, control) {
  let verdict = null
  if (response.status === 401 || response.status === 403) {
    verdict = { state: 'unauthorized', reason: `http_${response.status}` }
  } else if (response.status === 402) {
    verdict = { state: 'exhausted', reason: 'http_402' }
  } else if (response.status === 400) {
    const markers = providerHasRotatingBodyMarkers(provider)
      ? ['privacy settings', ...QUOTA_BODY_MARKERS]
      : ['privacy settings']
    let body
    try {
      body = (await readResponseCloneText(response, {
        signal: control?.signal,
        timeoutMs: RETRY_RESPONSE_TIMEOUT_MS,
      })).toLowerCase()
    } catch {
      if (control?.signal?.aborted) throw control.signal.reason
      body = null
    }
    const marker = body === null ? undefined : markers.find(marker => body.includes(marker))
    if (marker !== undefined) {
      const label = marker === 'insufficient' && body.includes('insufficient credit')
        ? 'insufficient_credits'
        : marker
      verdict = credentialFailureState(marker, label)
    }
  }
  if (verdict === null) return false
  // Recorded for every provider, including one whose key cannot rotate: the
  // request outcome is the health fact, and the pool's size only decides
  // whether this gateway can do anything about it.
  recordRouteHealth(provider, routeHealthNumberOf(credentials), verdict.state, verdict.reason)
  return credentials?.size > 1
}

function retryableConnectionError(error, signal) {
  if (signal?.aborted) return false
  const code = String(error?.code || '').toUpperCase()
  const message = errorMessage(error).toLowerCase()
  return code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    message.includes('fetch failed') ||
    message.includes('socket') ||
    message.includes('connection reset')
}

function retryDelayMs(retryNumber, response) {
  const hinted = retryAfterMs(response)
  if (hinted != null) return hinted
  const exponential = UPSTREAM_RETRY_BASE_MS * (2 ** Math.max(0, retryNumber - 1))
  return Math.min(UPSTREAM_RETRY_MAX_MS, exponential)
}

async function waitForRetry(delayMs, signal) {
  if (delayMs <= 0) return
  await new Promise((resolve, reject) => {
    let timer = null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, delayMs)
    const abort = () => {
      cleanup()
      reject(signal.reason || new Error('Gateway request aborted'))
    }
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/**
 * A numbered credential pool over one environment prefix.
 *
 * Keys are resolved on every access rather than being frozen at construction,
 * from `env` and an optional transient `overlay` that is consulted first. The
 * gateway's real environment is what the keysafe chain injects at spawn; the
 * overlay is how a key that appears mid-session reaches the live process
 * without a restart (see the /gateway/keys route). Selection follows the
 * current key's NUMBER, so a key added or removed between accesses does not
 * silently slide the selection to a different key.
 *
 * A number that was not present on the first read is a mid-cycle add: it is
 * promoted to the front of the rotation, tried twice, and then the rotation
 * resumes from the number that was selected before it appeared.
 */
export function credentialPool({
  env = process.env,
  prefix,
  overlay = null,
  onPromote = null,
} = {}) {
  const namePattern = new RegExp(`^${prefix}(?:[2-9]|[1-9][0-9]+)?$`)
  const numberOf = name => Number(name.slice(prefix.length) || 1)
  const lookup = name => (overlay && name in overlay ? overlay[name] : env[name])
  const namesFor = () => {
    const names = new Set(Object.keys(env))
    if (overlay) for (const name of Object.keys(overlay)) names.add(name)
    return [...names]
      .filter(name => namePattern.test(name) && lookup(name))
      .sort((a, b) => numberOf(a) - numberOf(b))
  }
  let preferred = 1
  // The number that actually served the last upstream reply, which is not
  // always the selected one: the preference file can re-select on the next
  // access, and a failover advances the pool past the key that just answered.
  // The usage read follows this so it reports the account that is really in use.
  let lastServedNumber = null
  // The numbers present when the pool was built. A number that first appears
  // after that is a mid-cycle key add and is promoted. Snapshotting here rather
  // than on the first read matters: a pool whose first read already sees the new
  // key must not mistake it for one that was always there.
  let observed = new Set(namesFor().map(numberOf))
  // The promoted key: tried next, twice, then the rotation resumes from `resume`.
  let pending = null
  const indexFor = names => {
    const at = names.findIndex(name => numberOf(name) === preferred)
    return at < 0 ? 0 : at
  }
  const currentNumber = () => {
    const names = namesFor()
    return numberOf(names[indexFor(names)] ?? '') || 1
  }
  const emit = () => onPromote?.(pending ? { ...pending } : null)
  const promote = number => {
    // The pre-promotion selection is recorded before it is overwritten, so the
    // rotation can resume from exactly where the detour began.
    const resume = currentNumber()
    pending = { number, attemptsLeft: 2, resume }
    preferred = number
    emit()
  }
  // Diff the live numbers against the previous read, promoting a number that has
  // just appeared. Returns true when a promotion was made during this call.
  const observe = names => {
    const numbers = names.map(numberOf)
    const fresh = numbers.filter(number => !observed.has(number))
    observed = new Set(numbers)
    if (fresh.length === 0 || pending) return false
    // Several keys added at once promote the newest (highest) one.
    promote(fresh[fresh.length - 1])
    return true
  }
  return {
    get key() {
      const names = namesFor()
      observe(names)
      return lookup(names[indexFor(names)])
    },
    get size() { return namesFor().length },
    get number() { return currentNumber() },
    get numbers() {
      const names = namesFor()
      observe(names)
      return names.map(numberOf)
    },
    get lastServed() { return lastServedNumber },
    get pending() { return pending ? { ...pending } : null },
    // The key for a specific number, so a read can target an account without
    // moving the pool's own selection.
    keyFor(number) {
      const name = namesFor().find(name => numberOf(name) === number)
      return name ? lookup(name) : undefined
    },
    // Called when an upstream reply is 2xx, to record which key answered.
    markServed() { lastServedNumber = currentNumber() },
    select(number) {
      if (!namesFor().some(name => numberOf(name) === number)) return false
      preferred = number
      return true
    },
    // Adopt a promotion decided by another pool (or restored from the
    // preference file). Silent, so adopting cannot re-broadcast.
    adoptPending(record) {
      if (!record || !Number.isSafeInteger(record.number)) { pending = null; return }
      pending = {
        number: record.number,
        attemptsLeft: Number.isSafeInteger(record.attemptsLeft) && record.attemptsLeft > 0
          ? record.attemptsLeft
          : 2,
        resume: currentNumber(),
      }
      preferred = record.number
    },
    advance() {
      const names = namesFor()
      if (names.length === 0) return
      // A key that appeared during this call is the next attempt; the promotion
      // itself does not consume a bonus try.
      if (observe(names)) return
      if (pending) {
        if (pending.attemptsLeft > 1) {
          pending.attemptsLeft -= 1
          preferred = pending.number
          return
        }
        // Both tries on the new key are spent: resume the rotation from the
        // number that was selected before the promotion.
        preferred = pending.resume
        pending = null
        emit()
        return
      }
      const order = namesFor()
      if (order.length === 0) return
      preferred = numberOf(order[(indexFor(order) + 1) % order.length])
    },
    redact(message) {
      return namesFor().reduce((text, name) => redactSecret(text, lookup(name)), message)
    },
  }
}

// The OpenCode-Go multi-account pool: OPENCODE_API_KEY, __KEY2, __KEY3 ...
export function openCodeCredentialPool(env = process.env, overlay = null, onPromote = null) {
  return credentialPool({ env, prefix: 'OPENCODE_API_KEY', overlay, onPromote })
}

// Transient, per-process overlay for a key that appears mid-session. It is
// never written to the real environment and never persisted; the ordinary
// keysafe chain supplies the key on the next spawn. Every pool consults it
// first, so an injected key is visible immediately without a restart.
const gatewayKeyOverlay = Object.create(null)

const openCodePreferencePath = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'opencode-account.json')
let openCodeGlobalNumber = 1

function openCodePoolList() {
  return [openCodeCredentials, ...[...openCodeSessionCredentials.values()].map(entry => entry.pool)]
}

// Record a promotion in the preference file so a respawn re-promotes the key
// rather than silently dropping the priority. Only the promoted number is kept;
// the try count restarts when it is adopted.
async function persistOpenCodePromotion(record) {
  const temp = `${openCodePreferencePath}.${randomUUID()}.tmp`
  try {
    let saved = {}
    try { saved = JSON.parse(await fs.readFile(openCodePreferencePath, 'utf8')) } catch {}
    const next = {}
    if (Number.isSafeInteger(saved?.number) && saved.number > 0) next.number = saved.number
    if (record && Number.isSafeInteger(record.number)) next.pendingNew = { number: record.number }
    await fs.mkdir(path.dirname(openCodePreferencePath), { recursive: true })
    await fs.writeFile(temp, JSON.stringify(next))
    await fs.rename(temp, openCodePreferencePath)
  } catch {
    await fs.unlink(temp).catch(() => {})
  }
}

// A pool that promotes a new key tells every other opencode pool, so a session
// pool created before the key existed promotes it too.
function openCodePromotion(record) {
  if (record) {
    for (const pool of openCodePoolList()) {
      if (pool.pending?.number !== record.number) pool.adoptPending(record)
    }
  }
  void persistOpenCodePromotion(record)
}

const openCodeCredentials = openCodeCredentialPool(process.env, gatewayKeyOverlay, openCodePromotion)
const openCodeSessionCredentials = new Map()

// CommandCode runs one process-wide pool, so a promotion has no sibling pool to
// hear about it - only the preference needs saving, so a numbered key that
// appeared mid-session keeps its priority if the gateway respawns. The file has
// the same shape as the OpenCode preference so both are read the same way.
const commandCodePreferencePath = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'commandcode-account.json')

async function persistCommandCodePromotion(record) {
  const temp = `${commandCodePreferencePath}.${randomUUID()}.tmp`
  try {
    let saved = {}
    try { saved = JSON.parse(await fs.readFile(commandCodePreferencePath, 'utf8')) } catch {}
    const next = {}
    if (Number.isSafeInteger(saved?.number) && saved.number > 0) next.number = saved.number
    if (record && Number.isSafeInteger(record.number)) next.pendingNew = { number: record.number }
    await fs.mkdir(path.dirname(commandCodePreferencePath), { recursive: true })
    await fs.writeFile(temp, JSON.stringify(next))
    await fs.rename(temp, commandCodePreferencePath)
  } catch {
    await fs.unlink(temp).catch(() => {})
  }
}

let commandCodeGlobalNumber = 1
const commandCodeSessionCredentials = new Map()

function commandCodePoolList() {
  return [commandCodeCredentials, ...[...commandCodeSessionCredentials.values()].map(entry => entry.pool)]
}

// A CommandCode pool that promotes a new key tells every other CommandCode pool,
// so a session pool created before the key existed promotes it too, and the
// promotion is written down so a respawn re-applies it.
function commandCodePromotion(record) {
  if (record) {
    for (const pool of commandCodePoolList()) {
      if (pool.pending?.number !== record.number) pool.adoptPending(record)
    }
  }
  void persistCommandCodePromotion(record)
}

export function commandCodeCredentialPool(env = process.env, overlay = null, onPromote = null) {
  return credentialPool({ env, prefix: 'COMMANDCODE_API_KEY', overlay, onPromote })
}

// The CommandCode pool: COMMANDCODE_API_KEY, __KEY2, __KEY3 ... It shares the
// transient overlay and the same rotation/priority behaviour as OpenCode-Go.
const commandCodeCredentials = credentialPool({
  env: process.env,
  prefix: 'COMMANDCODE_API_KEY',
  overlay: gatewayKeyOverlay,
  onPromote: commandCodePromotion,
})

// Per-session CommandCode pools, mirroring the OpenCode-Go selection contract: a
// session may pin its own account, while every unpinned session follows the
// global default persisted in commandcode-account.json. With no session id the
// process-wide pool is returned, which is what background/no-session callers use.
async function sessionCommandCodeCredentials(sessionId) {
  let number = 1
  let saved = null
  try {
    saved = JSON.parse(await fs.readFile(commandCodePreferencePath, 'utf8'))
    if (Number.isSafeInteger(saved.number) && saved.number > 0) number = saved.number
  } catch {}
  if (number !== commandCodeGlobalNumber) {
    commandCodeGlobalNumber = number
    commandCodeCredentials.select(number)
    for (const entry of commandCodeSessionCredentials.values()) {
      if (!entry.explicit) entry.pool.select(number)
    }
  }
  // A promotion recorded before a respawn is re-applied to any pool that has
  // not already adopted it.
  const carried = saved?.pendingNew
  if (carried && Number.isSafeInteger(carried.number) && number !== carried.number) {
    for (const pool of commandCodePoolList()) {
      if (pool.pending?.number !== carried.number && pool.numbers.includes(carried.number)) {
        pool.adoptPending(carried)
      }
    }
  }
  if (!sessionId) return commandCodeCredentials
  let entry = commandCodeSessionCredentials.get(sessionId)
  if (!entry) {
    entry = { pool: commandCodeCredentialPool(process.env, gatewayKeyOverlay, commandCodePromotion), explicit: false }
    entry.pool.select(commandCodeGlobalNumber)
    commandCodeSessionCredentials.set(sessionId, entry)
  }
  return entry.pool
}

// Session-aware: the caller passes the per-request session id so a pinned
// account choice is honoured, and no id falls back to the process-wide pool.
async function ensureCommandCodePreference(sessionId) {
  return sessionCommandCodeCredentials(sessionId)
}

async function sessionOpenCodeCredentials(sessionId) {
  let number = 1
  let saved = null
  try {
    saved = JSON.parse(await fs.readFile(openCodePreferencePath, 'utf8'))
    if (Number.isSafeInteger(saved.number) && saved.number > 0) number = saved.number
  } catch {}
  if (number !== openCodeGlobalNumber) {
    openCodeGlobalNumber = number
    openCodeCredentials.select(number)
    for (const entry of openCodeSessionCredentials.values()) {
      if (!entry.explicit) entry.pool.select(number)
    }
  }
  // A promotion recorded before a respawn is re-applied to any pool that has
  // not already adopted it.
  const carried = saved?.pendingNew
  if (carried && Number.isSafeInteger(carried.number) && number !== carried.number) {
    for (const pool of openCodePoolList()) {
      if (pool.pending?.number !== carried.number && pool.numbers.includes(carried.number)) {
        pool.adoptPending(carried)
      }
    }
  }
  if (!sessionId) return openCodeCredentials
  let entry = openCodeSessionCredentials.get(sessionId)
  if (!entry) {
    entry = { pool: openCodeCredentialPool(process.env, gatewayKeyOverlay, openCodePromotion), explicit: false }
    entry.pool.select(openCodeGlobalNumber)
    openCodeSessionCredentials.set(sessionId, entry)
  }
  return entry.pool
}

// Mistral's pool mirrors CommandCode's: MISTRAL_API_KEY, __KEY2, __KEY3 ...,
// one process-wide pool plus per-session pins, a promotion broadcast to the
// sibling pools and written to a preference file so a respawn re-applies it.
const mistralPreferencePath = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'mistral-account.json')

async function persistMistralPromotion(record) {
  const temp = `${mistralPreferencePath}.${randomUUID()}.tmp`
  try {
    let saved = {}
    try { saved = JSON.parse(await fs.readFile(mistralPreferencePath, 'utf8')) } catch {}
    const next = {}
    if (Number.isSafeInteger(saved?.number) && saved.number > 0) next.number = saved.number
    if (record && Number.isSafeInteger(record.number)) next.pendingNew = { number: record.number }
    await fs.mkdir(path.dirname(mistralPreferencePath), { recursive: true })
    await fs.writeFile(temp, JSON.stringify(next))
    await fs.rename(temp, mistralPreferencePath)
  } catch {
    await fs.unlink(temp).catch(() => {})
  }
}

let mistralGlobalNumber = 1
const mistralSessionCredentials = new Map()

function mistralPoolList() {
  return [mistralCredentials, ...[...mistralSessionCredentials.values()].map(entry => entry.pool)]
}

function mistralPromotion(record) {
  if (record) {
    for (const pool of mistralPoolList()) {
      if (pool.pending?.number !== record.number) pool.adoptPending(record)
    }
  }
  void persistMistralPromotion(record)
}

export function mistralCredentialPool(env = process.env, overlay = null, onPromote = null) {
  return credentialPool({ env, prefix: 'MISTRAL_API_KEY', overlay, onPromote })
}

const mistralCredentials = mistralCredentialPool(process.env, gatewayKeyOverlay, mistralPromotion)

async function sessionMistralCredentials(sessionId) {
  let number = 1
  let saved = null
  try {
    saved = JSON.parse(await fs.readFile(mistralPreferencePath, 'utf8'))
    if (Number.isSafeInteger(saved.number) && saved.number > 0) number = saved.number
  } catch {}
  if (number !== mistralGlobalNumber) {
    mistralGlobalNumber = number
    mistralCredentials.select(number)
    for (const entry of mistralSessionCredentials.values()) {
      if (!entry.explicit) entry.pool.select(number)
    }
  }
  const carried = saved?.pendingNew
  if (carried && Number.isSafeInteger(carried.number) && number !== carried.number) {
    for (const pool of mistralPoolList()) {
      if (pool.pending?.number !== carried.number && pool.numbers.includes(carried.number)) {
        pool.adoptPending(carried)
      }
    }
  }
  if (!sessionId) return mistralCredentials
  let entry = mistralSessionCredentials.get(sessionId)
  if (!entry) {
    entry = { pool: mistralCredentialPool(process.env, gatewayKeyOverlay, mistralPromotion), explicit: false }
    entry.pool.select(mistralGlobalNumber)
    mistralSessionCredentials.set(sessionId, entry)
  }
  return entry.pool
}

async function ensureMistralPreference(sessionId) {
  return sessionMistralCredentials(sessionId)
}

// Vibe plan keys are a separate credential TYPE from Studio API keys, not a
// different endpoint, header or model id: Mistral decides which budget a
// request spends from the key it was authenticated with. Vibe Code budget is
// consumed before pay-as-you-go, so the route tries a Vibe key first and only
// falls to the Studio pool when every Vibe slot has failed.
//
// A Vibe key that cannot serve answers 401 (ambiguous with an invalid key) or
// 402 (prepaid credits gone). 401/402/403 are already the pool's credential
// failures, so the fallback needs no special status handling. A failed Vibe
// number is remembered for the life of the process: retrying an exhausted
// monthly budget on every turn would spend a call to learn what the last one
// already proved.
export function mistralVibeCredentialPool(env = process.env, overlay = null) {
  return credentialPool({ env, prefix: 'MISTRAL_VIBE_KEY', overlay })
}

const mistralVibeCredentials = mistralVibeCredentialPool(process.env, gatewayKeyOverlay)
const mistralVibeFailed = new Set()

// Studio numbers are reported above the Vibe range so a health bit names the
// credential that produced it rather than a slot number shared by both pools.
const MISTRAL_STUDIO_SLOT_OFFSET = 1000

/**
 * The credential surface the Mistral handler spends: Vibe first, Studio second.
 *
 * `vibePool` and `failed` are passed in so the ordering contract can be unit
 * tested with synthetic keys; the production wrapper below supplies the live
 * pools. Every getter re-reads the pools, so a key injected into a running
 * gateway is visible without a restart.
 */
export function createMistralRouteCredentials(vibePool, apiPool, failed = new Set()) {
  let lastServed = null
  const availableVibe = () => vibePool.numbers.filter(number => !failed.has(number))
  const selectedVibe = () => availableVibe()[0]
  return {
    get key() {
      const number = selectedVibe()
      return number === undefined ? apiPool.key : vibePool.keyFor(number)
    },
    get size() {
      return vibePool.size + apiPool.size
    },
    get number() {
      const number = selectedVibe()
      return number === undefined ? MISTRAL_STUDIO_SLOT_OFFSET + apiPool.number : number
    },
    get numbers() {
      return [
        ...vibePool.numbers,
        ...apiPool.numbers.map(number => MISTRAL_STUDIO_SLOT_OFFSET + number),
      ]
    },
    get lastServed() {
      return lastServed
    },
    markServed() {
      const number = selectedVibe()
      lastServed = number === undefined ? MISTRAL_STUDIO_SLOT_OFFSET + apiPool.number : number
      if (number === undefined) apiPool.markServed()
      else vibePool.markServed()
    },
    /**
     * A credential failure moves off the key that produced it. Within Vibe the
     * next live key is tried; once none remain the Studio pool rotates
     * normally, and Vibe is not revisited until the gateway respawns.
     */
    advance() {
      const number = selectedVibe()
      if (number !== undefined) {
        failed.add(number)
        const next = selectedVibe()
        if (next !== undefined) vibePool.select(next)
        return
      }
      apiPool.advance()
    },
    redact(message) {
      return apiPool.redact(vibePool.redact(message))
    },
  }
}

/**
 * Vibe plan keys are a separate credential type from Studio API keys; the
 * route spends the Vibe plan budget first and only falls back to Studio when
 * every Vibe slot has failed. The Studio pool is per session (its account can
 * be pinned); the Vibe pool is process-wide because its only selection is
 * "which key is still alive".
 */
export function mistralRouteCredentials(apiPool = mistralCredentials) {
  return createMistralRouteCredentials(mistralVibeCredentials, apiPool, mistralVibeFailed)
}

// DeepSeek runs one key per request, so several keys need the same numbering
// as the other providers: DEEPSEEK_API_KEY, __KEY2, ... A rejected key is
// rotated past exactly like an OpenCode or CommandCode account.
const deepSeekPreferencePath = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'deepseek-account.json')

async function persistDeepSeekPromotion(record) {
  const temp = `${deepSeekPreferencePath}.${randomUUID()}.tmp`
  try {
    let saved = {}
    try { saved = JSON.parse(await fs.readFile(deepSeekPreferencePath, 'utf8')) } catch {}
    const next = {}
    if (Number.isSafeInteger(saved?.number) && saved.number > 0) next.number = saved.number
    if (record && Number.isSafeInteger(record.number)) next.pendingNew = { number: record.number }
    await fs.mkdir(path.dirname(deepSeekPreferencePath), { recursive: true })
    await fs.writeFile(temp, JSON.stringify(next))
    await fs.rename(temp, deepSeekPreferencePath)
  } catch {
    await fs.unlink(temp).catch(() => {})
  }
}

let deepSeekGlobalNumber = 1
const deepSeekSessionCredentials = new Map()

function deepSeekPoolList() {
  return [deepSeekCredentials, ...[...deepSeekSessionCredentials.values()].map(entry => entry.pool)]
}

function deepSeekPromotion(record) {
  if (record) {
    for (const pool of deepSeekPoolList()) {
      if (pool.pending?.number !== record.number) pool.adoptPending(record)
    }
  }
  void persistDeepSeekPromotion(record)
}

export function deepSeekCredentialPool(env = process.env, overlay = null, onPromote = null) {
  return credentialPool({ env, prefix: 'DEEPSEEK_API_KEY', overlay, onPromote })
}

const deepSeekCredentials = deepSeekCredentialPool(process.env, gatewayKeyOverlay, deepSeekPromotion)

// Per-session pins mirror CommandCode: a session may hold its own key while
// every unpinned session follows the global default in deepseek-account.json.
async function sessionDeepSeekCredentials(sessionId) {
  let number = 1
  let saved = null
  try {
    saved = JSON.parse(await fs.readFile(deepSeekPreferencePath, 'utf8'))
    if (Number.isSafeInteger(saved.number) && saved.number > 0) number = saved.number
  } catch {}
  if (number !== deepSeekGlobalNumber) {
    deepSeekGlobalNumber = number
    deepSeekCredentials.select(number)
    for (const entry of deepSeekSessionCredentials.values()) {
      if (!entry.explicit) entry.pool.select(number)
    }
  }
  const carried = saved?.pendingNew
  if (carried && Number.isSafeInteger(carried.number) && number !== carried.number) {
    for (const pool of deepSeekPoolList()) {
      if (pool.pending?.number !== carried.number && pool.numbers.includes(carried.number)) {
        pool.adoptPending(carried)
      }
    }
  }
  if (!sessionId) return deepSeekCredentials
  let entry = deepSeekSessionCredentials.get(sessionId)
  if (!entry) {
    entry = { pool: deepSeekCredentialPool(process.env, gatewayKeyOverlay, deepSeekPromotion), explicit: false }
    entry.pool.select(deepSeekGlobalNumber)
    deepSeekSessionCredentials.set(sessionId, entry)
  }
  return entry.pool
}

// A key just landed in the overlay: touch the owning pool so the new number is
// detected and promoted now, rather than on whichever request reads it next.
function noteGatewayKeyInjected(name) {
  if (name.startsWith('OPENCODE_API_KEY')) {
    for (const pool of openCodePoolList()) void pool.numbers
  } else if (name.startsWith('COMMANDCODE_API_KEY')) {
    for (const pool of commandCodePoolList()) void pool.numbers
  } else if (name.startsWith('MISTRAL_VIBE_KEY')) {
    void mistralVibeCredentials.numbers
  } else if (name.startsWith('MISTRAL_API_KEY')) {
    for (const pool of mistralPoolList()) void pool.numbers
  } else if (name.startsWith('DEEPSEEK_API_KEY')) {
    for (const pool of deepSeekPoolList()) void pool.numbers
  }
}

// ---------------------------------------------------------------------------
// Route health: can this CREDENTIAL serve at all?
//
// Liveness and route health are different axes. A peer answering a ping proves
// its process is up; it says nothing about whether the key its next call will
// use still has credits. This store is the second axis, and it is keyed by
// provider + credential NUMBER, never by model string: several model ids alias
// onto one key, so a model-keyed bit would be true for a sibling that happens to
// be served by a different account.
//
// In-memory on purpose. A respawned gateway knows nothing, and the safety rule
// is that nothing known is reported as unknown - never as serving. Persisting
// this would let a bit outlive the account state that produced it, which is the
// failure mode the bit exists to prevent.
// ---------------------------------------------------------------------------
const ROUTE_HEALTH = new Map()

const ROUTE_HEALTH_PROVIDERS = new Map([
  ['command code', 'commandcode'],
  ['commandcode', 'commandcode'],
  ['mistral', 'mistral'],
  ['mistral api', 'mistral-api'],
  ['mistral-api', 'mistral-api'],
  ['mistral vibe', 'mistral-vibe'],
  ['mistral-vibe', 'mistral-vibe'],
  ['opencode go', 'opencode-go'],
  ['opencode-go', 'opencode-go'],
  ['opencode zen', 'opencode-zen'],
  ['opencode-zen', 'opencode-zen'],
  ['codex', 'codex'],
  ['codex chatgpt', 'codex'],
  ['deepseek', 'deepseek'],
  ['amd radeon', 'amd-radeon'],
  ['amd-radeon', 'amd-radeon'],
  ['anthropic', 'anthropic'],
  ['codex', 'codex'],
])

/** The canonical provider id a health bit is keyed under, or null when unknown. */
export function routeHealthProviderId(provider) {
  const key = String(provider ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
  return ROUTE_HEALTH_PROVIDERS.get(key) ?? null
}

/** The credential number a provider's call is using, 1 when it has no pool. */
function routeHealthNumberOf(credentials) {
  return Number.isSafeInteger(credentials?.number) && credentials.number > 0 ? credentials.number : 1
}

/**
 * Record one outcome for one credential.
 *
 * Only the three states that are evidence are accepted. There is no way to
 * record 'unknown': a credential is unknown exactly while it has no entry, so
 * clearing the map is the only way back to it.
 */
export function recordRouteHealth(provider, number, state, reason) {
  if (!['serving', 'exhausted', 'unauthorized'].includes(state)) return false
  if (!Number.isSafeInteger(number) || number < 1) return false
  const id = routeHealthProviderId(provider)
  if (!id) return false
  ROUTE_HEALTH.set(`${id}:${number}`, {
    provider: id,
    number,
    state,
    reason: String(reason ?? '').slice(0, 120),
    at: new Date().toISOString(),
  })
  return true
}

/**
 * What is known about one credential.
 *
 * A credential with no recorded outcome is `unknown` with `health_unavailable`,
 * and `at` is null rather than a fabricated timestamp: the caller must be able
 * to tell "never observed" from "observed a while ago".
 */
export function routeHealthFor(provider, number) {
  const id = routeHealthProviderId(provider)
  if (!id) return { provider: provider ?? null, number: number ?? null, state: 'unknown', reason: 'unknown_provider', at: null }
  if (!Number.isSafeInteger(number) || number < 1) {
    return { provider: id, number: number ?? null, state: 'unknown', reason: 'unknown_credential', at: null }
  }
  const record = ROUTE_HEALTH.get(`${id}:${number}`)
  if (!record) return { provider: id, number, state: 'unknown', reason: 'health_unavailable', at: null }
  return { ...record }
}

/** Forget every recorded outcome. Used by tests; a respawn does this implicitly. */
export function resetRouteHealth() {
  ROUTE_HEALTH.clear()
}

/** The credential number a session's pool would select for a provider. */
async function sessionRouteNumber(providerId, sessionId) {
  if (providerId === 'commandcode') return (await sessionCommandCodeCredentials(sessionId)).number
  if (providerId === 'mistral') return mistralRouteCredentials(await sessionMistralCredentials(sessionId)).number
  if (providerId === 'mistral-api') return (await sessionMistralCredentials(sessionId)).number
  if (providerId === 'mistral-vibe') return mistralVibeCredentials.number
  if (providerId === 'opencode-go' || providerId === 'opencode-zen') return (await sessionOpenCodeCredentials(sessionId)).number
  return 1
}

/**
 * The numbered credentials a provider's request path would actually try.
 *
 * Pooled providers answer from the live pool. That getter re-reads the
 * environment and the transient overlay on every access, so a key the keysafe
 * child injected into a running gateway appears here with no restart - which is
 * what makes asking twice a real reload of the credential set. A single-key
 * provider (deepseek, amd-radeon, anthropic, codex) has exactly one credential
 * slot by construction, so its fleet is that slot; an unconfigured slot reads
 * `unknown`, never serving.
 */
async function providerRouteNumbers(providerId, sessionId) {
  if (providerId === 'commandcode') return (await sessionCommandCodeCredentials(sessionId)).numbers
  if (providerId === 'mistral') return mistralRouteCredentials(await sessionMistralCredentials(sessionId)).numbers
  if (providerId === 'mistral-api') return (await sessionMistralCredentials(sessionId)).numbers
  if (providerId === 'mistral-vibe') return mistralVibeCredentials.numbers
  if (providerId === 'opencode-go' || providerId === 'opencode-zen') return (await sessionOpenCodeCredentials(sessionId)).numbers
  return [1]
}

/**
 * What a provider's whole credential pool can do, as one verdict.
 *
 * The defect this closes: the gateway rotates on exactly the reply that marks a
 * credential unusable (400 insufficient credits, 401, 402), so a pool with one
 * dead key and one live key still answers. A caller that asked about the single
 * key the session would select FIRST was told the route was dead while it was
 * serving fine on the next key. The fleet verdict is the pool's ability, not
 * the selected key's.
 *
 * Order is deliberate:
 * - serving wins outright: one key that answered is proof the provider can serve.
 * - unknown outranks exhausted: a credential nothing has exercised is NOT proof
 *   of failure, and a caller must never withhold on a non-answer.
 * - exhausted before unauthorized: a pool that is partly out of credit reads as
 *   replenishable, which is the weaker and more actionable of the two claims.
 * - all unauthorized is the only case where the credentials themselves are wrong.
 */
export function fleetRouteHealth(providerId, numbers) {
  const list = [...new Set(numbers)].sort((a, b) => a - b).map(number => {
    const health = routeHealthFor(providerId, number)
    return { number, state: health.state, reason: health.reason, at: health.at }
  })
  const any = state => list.some(entry => entry.state === state)
  const fleet = list.length === 0 ? 'unknown'
    : any('serving') ? 'serving'
    : any('unknown') ? 'unknown'
    : any('exhausted') ? 'exhausted'
    : 'unauthorized'
  return { provider: providerId, fleet, size: list.length, numbers: list }
}

// Only the numbered pools consult the overlay, so only their variables can be
// live-injected. A single-key provider (DeepSeek, AMD) would be a silent no-op.
const POOLED_KEY_PATTERN = /^(?:OPENCODE_API_KEY|COMMANDCODE_API_KEY|MISTRAL_API_KEY|MISTRAL_VIBE_KEY)(?:[2-9]|[1-9][0-9]+)?$/

function isPooledKeyEnvVar(name) {
  return typeof name === 'string' && POOLED_KEY_PATTERN.test(name)
}

export async function fetchWithRetry({
  provider,
  url,
  options,
  control,
  trace,
  credentials,
}) {
  let lastError = null
  // A stalled account gets exactly one successor. The deadline is a queueing
  // signal, not proof the route is dead, and walking the whole pool would cost
  // a full header window per key before the caller hears anything.
  let timeoutFailovers = 0
  const retries = Math.max(UPSTREAM_RETRIES, credentials?.size > 1 ? credentials.size : 0)
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    // Each attempt arms its own header deadline; a retry gets the shorter
    // window that exists for retries. `undefined` means "the full window".
    const signal = control.beginUpstreamAttempt
      ? control.beginUpstreamAttempt(attempt === 1 ? undefined : RETRY_RESPONSE_TIMEOUT_MS)
      : control.signal
    try {
      // A pool whose credential comes from a file (Codex homes) resolves its
      // headers asynchronously; a synchronous option builder is unaffected.
      const resolvedOptions = typeof options === 'function' ? await options() : options
      const response = await fetch(url, { ...resolvedOptions, signal })
      trace.markUpstreamConnect()
      control.upstreamConnected()
      const failedCredential = await credentialFailure(provider, response, credentials, control)
      if (response.ok || !(failedCredential || await retryableResponse(provider, response, control)) || attempt > retries) {
        // A 2xx is the key that answered, recorded for the usage read; pools
        // that do not rotate (or do not track this) simply ignore the call.
        // It is also the only evidence that a credential is currently serving,
        // and it names the NUMBER that answered rather than the selected one:
        // a failover advances the pool, so the two differ exactly after a retry.
        if (response.ok) {
          credentials?.markServed?.()
          const served = Number.isSafeInteger(credentials?.lastServed) && credentials.lastServed > 0
            ? credentials.lastServed
            : routeHealthNumberOf(credentials)
          recordRouteHealth(provider, served, 'serving', 'http_200')
        }
        return response
      }

      credentials?.advance()
      const delay = retryDelayMs(attempt, response)
      await response.body?.cancel().catch(() => {})
      process.stderr.write(
        `model-gateway retry provider=${safeLogValue(provider)} status=${response.status} attempt=${attempt} delay_ms=${delay}\n`,
      )
      await waitForRetry(delay, control.signal)
    } catch (error) {
      lastError = error
      if (control.attemptTimedOut?.()) {
        // The provider never sent headers. The account may be queueing while a
        // sibling key answers, so this is a route failure rather than a
        // verdict on the request. Named on stderr because a bare 504 in a
        // session transcript cannot say which route stalled or for how long.
        const failover = timeoutFailovers < 1 && attempt <= retries && Number(credentials?.size) > 1
        process.stderr.write(
          `model-gateway timeout provider=${safeLogValue(provider)} attempt=${attempt} failover=${failover ? 'yes' : 'no'}\n`,
        )
        if (!failover) {
          error.gatewayStatus = 504
          throw error
        }
        timeoutFailovers += 1
        credentials.advance()
        await waitForRetry(retryDelayMs(attempt, null), control.signal)
        continue
      }
      if (!retryableConnectionError(error, control.signal) || attempt > retries) {
        throw error
      }
      credentials?.advance()
      const delay = retryDelayMs(attempt, null)
      process.stderr.write(
        `model-gateway retry provider=${safeLogValue(provider)} error=${safeLogValue(error?.code || classifyGatewayError(error))} attempt=${attempt} delay_ms=${delay}\n`,
      )
      await waitForRetry(delay, control.signal)
    }
  }
  throw lastError || new Error(`${provider} upstream request failed`)
}

function isContextWindowFailure(error) {
  const message = errorMessage(error).toLowerCase()
  return (
    message.includes('prompt is too long') ||
    message.includes('exceeds the context window') ||
    message.includes('context window limit') ||
    message.includes('context length') ||
    message.includes('maximum context')
  )
}

function retryablePreOutputRelayError(error) {
  const errorClass = classifyGatewayError(error)
  return errorClass === 'malformed-response' ||
    errorClass === 'connection-reset' ||
    errorClass === 'upstream-error'
}

function finishAnthropicPromptTooLongError(res, error) {
  const detail = errorMessage(error)
  const message = detail.toLowerCase().startsWith('prompt is too long')
    ? detail
    : `Prompt is too long: ${detail}`
  anthropicError(res, 400, message)
}

export async function relayCodexStream(
  res,
  upstream,
  model,
  trace = null,
  control = null,
  options = {},
) {
  let contentIndex = 0
  let activeText = false
  let activeTool = null
  let sawOutput = false
  let toolCallSeen = false
  let usage = null
  let reader = null
  let sawCompletion = false
  let buffer = ''
  let streamStarted = false
  let pendingTool = null
  // Codex streams its pre-search commentary and its final answer as two
  // `message` items. Both arrive as `response.output_text.delta`, which carries
  // no phase, so the delta has to be attributed to whichever message is open.
  let messagePhase = null

  const startStream = () => {
    if (streamStarted) return
    startAnthropicStream(res, model)
    streamStarted = true
  }

  const closeActive = () => {
    if (activeText || activeTool) sendEvent(res, 'content_block_stop', { index: contentIndex })
    activeText = false
    activeTool = null
  }

  const openText = () => {
    if (activeText) return
    startStream()
    closeActive()
    activeText = true
    sawOutput = true
    trace?.markOutput()
    sendEvent(res, 'content_block_start', {
      index: contentIndex,
      content_block: { type: 'text', text: '' },
    })
  }

  const openTool = item => {
    startStream()
    closeActive()
    activeTool = {
      callId: item.call_id || item.id || `call_${randomUUID().replaceAll('-', '')}`,
      name: item.name || 'tool',
    }
    toolCallSeen = true
    sawOutput = true
    trace?.markOutput()
    sendEvent(res, 'content_block_start', {
      index: contentIndex,
      content_block: {
        type: 'tool_use',
        id: activeTool.callId,
        name: activeTool.name,
        input: {},
      },
    })
  }

  const openPendingTool = (item, argumentsDelta = '') => {
    const hasToolIdentity = item &&
      typeof item === 'object' &&
      (item.call_id || item.id || item.name)
    const tool = hasToolIdentity ? item : pendingTool
    if (!tool) return false
    openTool(tool)
    pendingTool = null
    if (argumentsDelta) {
      sendEvent(res, 'content_block_delta', {
        index: contentIndex,
        delta: { type: 'input_json_delta', partial_json: argumentsDelta },
      })
    }
    return true
  }

  // Emit a completed hosted web search as the server-tool pair the Anthropic
  // contract expects. This is what makes the search visible to the caller as a
  // search rather than as unexplained latency before the answer.
  const emitWebSearch = item => {
    startStream()
    closeActive()
    sawOutput = true
    trace?.markOutput()
    const { contentBlock, resultBlock } = codexWebSearchResult(item)
    for (const block of [contentBlock, resultBlock]) {
      sendEvent(res, 'content_block_start', { index: contentIndex, content_block: block })
      sendEvent(res, 'content_block_stop', { index: contentIndex })
      contentIndex += 1
    }
  }

  control?.setStreamErrorFinalizer(() => {
    if (streamStarted) closeActive()
  })

  const emitCompletedOutputFallback = response => {
    if (sawOutput || !response?.output) return
    for (const item of response.output) {
      if (item.type === 'message') {
        // The final answer supersedes the pre-search commentary, so the
        // fallback emits only that rather than both.
        if (codexIsInterimMessage(item)) continue
        for (const part of item.content || []) {
          if (part.type === 'output_text' && part.text) {
            openText()
            sendEvent(res, 'content_block_delta', {
              index: contentIndex,
              delta: { type: 'text_delta', text: part.text },
            })
          }
        }
      } else if (item.type === 'function_call') {
        openTool(item)
        sendEvent(res, 'content_block_delta', {
          index: contentIndex,
          delta: { type: 'input_json_delta', partial_json: item.arguments || '{}' },
        })
      }
      // `web_search_call` is deliberately not replayed here: it is emitted when
      // its `.done` event arrives, and replaying it would run the search twice.
    }
  }

  const livenessStartedAt = Date.now()
  let lastLivenessAt = 0

  const handleEvent = event => {
    codexEventShape(event)
    const type = event?.type
    if (
      type === 'response.output_item.added' &&
      event.item?.type === 'message'
    ) {
      messagePhase = event.item.phase ?? null
      return
    }
    if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
      // Metadata alone is not usable output. Buffer it until arguments arrive
      // so a provider timeout cannot commit an incomplete Anthropic message.
      pendingTool = event.item
      return
    }
    if (type === 'response.output_item.done' && event.item?.type === 'web_search_call') {
      emitWebSearch(event.item)
      return
    }
    if (type === 'response.output_text.delta') {
      // Pre-search commentary is not the answer. Emitting it as assistant text
      // would show the user a message that the final answer then repeats.
      if (codexIsInterimMessage({ phase: messagePhase })) return
      const text = typeof event.delta === 'string' ? event.delta : ''
      if (!text) return
      openText()
      sendEvent(res, 'content_block_delta', {
        index: contentIndex,
        delta: { type: 'text_delta', text },
      })
      return
    }
    if (type === 'response.output_text.done') {
      if (!codexIsInterimMessage({ phase: messagePhase }) && !activeText && typeof event.text === 'string' && event.text) {
        openText()
        sendEvent(res, 'content_block_delta', {
          index: contentIndex,
          delta: { type: 'text_delta', text: event.text },
        })
      }
      return
    }
    if (type === 'response.output_item.done' && event.item?.type === 'message') {
      if (!codexIsInterimMessage(event.item) && !activeText) {
        const text = codexOutputText(event.item)
        if (text) {
          openText()
          sendEvent(res, 'content_block_delta', {
            index: contentIndex,
            delta: { type: 'text_delta', text },
          })
        }
      }
      messagePhase = null
      return
    }
    if (type === 'response.function_call_arguments.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : ''
      if (!delta) return
      if (!activeTool) {
        openPendingTool(event.item || {}, delta)
      } else {
        sendEvent(res, 'content_block_delta', {
          index: contentIndex,
          delta: { type: 'input_json_delta', partial_json: delta },
        })
      }
      return
    }
    if (type === 'response.output_item.done' && event.item?.type === 'function_call') {
      if (!activeTool) {
        const argumentsValue = typeof event.item.arguments === 'string'
          ? event.item.arguments
          : ''
        openPendingTool(event.item, argumentsValue || '{}')
      }
      closeActive()
      contentIndex += 1
      return
    }
    if (type === 'response.completed') {
      sawCompletion = true
      trace?.setCompletionShape?.(event.response || event)
      usage = event.response?.usage || event.usage || null
      trace?.setUsage?.(usage)
      emitCompletedOutputFallback(event.response)
      return
    }
    if (type === 'response.failed') {
      throw new Error(event.response?.error?.message || 'Codex response failed')
    }
    // Whatever else the provider emits — reasoning summaries above all — is
    // output the caller never sees. A caller running its own deadline reads
    // that silence as a stall and aborts work that is still under way, so the
    // provider's pulse is passed along. It rides on a message_delta carrying no
    // delta because that is the only event a caller can be sent that says
    // nothing: a `ping` never leaves the transport, where the client SDK stops
    // it, and a content block would show up as an empty message. Only before
    // any output, since from the first output on the caller has a stream to
    // read and every delta on it is proof enough.
    const now = Date.now()
    if (
      !sawOutput &&
      now - livenessStartedAt >= CODEX_LIVENESS_AFTER_MS &&
      now - lastLivenessAt >= CODEX_LIVENESS_INTERVAL_MS
    ) {
      lastLivenessAt = now
      startStream()
      sendEvent(res, 'message_delta', { delta: {} })
    }
  }

  try {
    const decoder = new TextDecoder()
    reader = upstream.body?.getReader()
    if (!reader) throw new Error('Codex returned an empty response body')

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      control?.upstreamActivity?.()
      trace?.markFirstByte()
      trace?.addBytes(value?.byteLength || 0)
      buffer += decoder.decode(value, { stream: true })
      trace?.addEvent()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (!data || data === '[DONE]') continue
        const event = JSON.parse(data)
        trace?.addEventType?.(event?.type)
        handleEvent(event)
        if (sawCompletion) {
          trace?.setCompletionShape?.(event.response || event)
          break
        }
      }
      if (sawCompletion) {
        await cancelUpstreamReader(reader, upstream)
        break
      }
    }

    if (!sawCompletion && buffer.startsWith('data: ')) {
      const data = buffer.slice(6)
      if (data && data !== '[DONE]') {
        const event = JSON.parse(data)
        trace?.addEventType?.(event?.type)
        handleEvent(event)
        if (sawCompletion) trace?.setCompletionShape?.(event.response || event)
      }
    }

    if (!sawCompletion) {
      throw new Error('Codex stream ended before response.completed')
    }
    if (!sawOutput) {
      throw new Error('Codex returned an empty or malformed response')
    }

    trace?.markCompletion()
    startStream()
    closeActive()
    sendEvent(res, 'message_delta', {
      delta: {
        stop_reason: toolCallSeen ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: {
        ...codexUsageToAnthropic(usage),
      },
    })
    sendEvent(res, 'message_stop', {})
    res.end()
    return true
  } catch (error) {
    process.stderr.write(
      `model-gateway codex stream-error model=${safeLogValue(model)} class=${safeLogValue(classifyGatewayError(error))}\n`,
    )
    trace?.markError(error)
    if (!streamStarted && options.throwPreOutput) {
      await cancelUpstreamReader(reader, upstream)
      throw error
    }
    if (!streamStarted) {
      if (isContextWindowFailure(error)) {
        finishAnthropicPromptTooLongError(res, error)
      } else {
        anthropicError(res, 502, errorMessage(error))
      }
      return
    }
    closeActive()
    finishAnthropicStreamWithError(res, error)
    return false
  } finally {
    reader?.releaseLock?.()
  }
}

async function responseIsContextWindowFailure(response) {
  if (response?.status !== 400 || typeof response.clone !== 'function') return false
  try {
    const raw = await response.clone().text()
    if (!raw) return false
    const values = []
    const collectStrings = value => {
      if (typeof value === 'string') {
        values.push(value)
      } else if (Array.isArray(value)) {
        for (const item of value) collectStrings(item)
      } else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) collectStrings(child)
      }
    }
    collectStrings(JSON.parse(raw))
    return values.some(value => isContextWindowFailure(new Error(value)))
  } catch {
    return false
  }
}

function copyResponseHeaders(upstream, includeStreamHeaders = false) {
  const headers = {}
  for (const name of ['content-type', 'cache-control', 'retry-after', 'x-request-id']) {
    const value = upstream.headers.get(name)
    if (value) headers[name] = value
  }
  if (includeStreamHeaders) {
    headers.connection = 'keep-alive'
    headers['x-accel-buffering'] = 'no'
  }
  return headers
}

function deepSeekEventHasUsableOutput(event) {
  if (event?.type === 'content_block_start') {
    // A web-search turn is carried by server-tool frames: the call
    // (`server_tool_use`) and its results (`web_search_tool_result`). They are
    // real output to the client, so the search counts as stream progress and
    // its frames flush live instead of being buffered and discarded as "no
    // usable output".
    const blockType = event.content_block?.type
    return (
      blockType === 'tool_use' ||
      blockType === 'server_tool_use' ||
      blockType === 'web_search_tool_result'
    )
  }
  if (event?.type !== 'content_block_delta') return false
  const delta = event.delta || {}
  if (delta.type === 'text_delta') return typeof delta.text === 'string' && delta.text.length > 0
  if (delta.type === 'input_json_delta') {
    return typeof delta.partial_json === 'string' && delta.partial_json.length > 0
  }
  if (delta.type === 'thinking_delta') {
    return typeof delta.thinking === 'string' && delta.thinking.length > 0
  }
  return false
}

function parseDeepSeekSseFrame(frame) {
  const data = frame
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') return null
  try {
    return JSON.parse(data)
  } catch {
    throw new Error('DeepSeek returned malformed Anthropic SSE data')
  }
}

async function writeDeepSeekChunk(res, chunk) {
  if (res.destroyed || res.writableEnded) return
  if (!res.write(chunk)) {
    await new Promise(resolve => res.once('drain', resolve))
  }
}

export async function relayDeepSeekStream(
  res,
  upstream,
  trace = null,
  options = {},
) {
  let streamStarted = false
  let sawOutput = false
  let sawMessageStop = false
  let pending = ''
  let buffer = ''
  let reader = null
  const signal = options.signal
  let aborted = false
  let onAbort = null
  const maxPendingBytes = 1024 * 1024

  const startStream = () => {
    if (streamStarted) return
    res.writeHead(upstream.status, copyResponseHeaders(upstream, true))
    streamStarted = true
    if (pending) {
      res.write(pending)
      pending = ''
    }
  }

  const emitFrame = async frame => {
    const event = parseDeepSeekSseFrame(frame)
    if (event?.type === 'error') {
      throw new Error(event.error?.message || 'DeepSeek Anthropic request failed')
    }
    if (event?.type === 'message_stop') sawMessageStop = true
    if (deepSeekEventHasUsableOutput(event)) {
      sawOutput = true
      trace?.markOutput()
      startStream()
    }
    if (streamStarted) {
      await writeDeepSeekChunk(res, frame)
      return
    }
    pending += frame
    if (Buffer.byteLength(pending, 'utf8') > maxPendingBytes) {
      throw new Error('DeepSeek response exceeded the pre-output buffer')
    }
  }

  try {
    reader = upstream.body?.getReader()
    if (!reader) throw new Error('DeepSeek returned an empty response body')
    onAbort = () => {
      aborted = true
      void cancelUpstreamReader(reader, upstream)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        if (aborted || signal?.aborted) {
          throw signal?.reason || new Error('Gateway request aborted')
        }
        break
      }
      if (aborted || signal?.aborted) {
        throw signal?.reason || new Error('Gateway request aborted')
      }
      trace?.markFirstByte()
      trace?.addBytes(value?.byteLength || 0)
      trace?.addEvent()
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() || ''
      for (const frame of frames) {
        if (frame) await emitFrame(`${frame}\n\n`)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) await emitFrame(buffer)

    if (!sawOutput) {
      throw new Error(sawMessageStop
        ? 'DeepSeek returned an empty or malformed response'
        : 'DeepSeek stream ended before usable output')
    }
    if (!sawMessageStop) throw new Error('DeepSeek stream ended before message_stop')
    trace?.markCompletion()
    res.end()
  } catch (error) {
    trace?.markError(error)
    await cancelUpstreamReader(reader, upstream)
    if (!streamStarted) {
      if (isContextWindowFailure(error)) finishAnthropicPromptTooLongError(res, error)
      else anthropicError(res, 502, errorMessage(error))
    } else {
      finishAnthropicStreamWithError(res, error)
    }
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    reader?.releaseLock()
  }
}

function deepSeekJsonHasUsableOutput(message) {
  return Array.isArray(message?.content) && message.content.some(block => {
    if (block?.type === 'text') return typeof block.text === 'string' && block.text.length > 0
    if (block?.type === 'tool_use') {
      return typeof block.id === 'string' && block.id.length > 0 &&
        typeof block.name === 'string' && block.name.length > 0
    }
    if (block?.type === 'thinking') return typeof block.thinking === 'string' && block.thinking.length > 0
    return false
  })
}

function deepSeekJsonFailure(response) {
  const detail = [
    response?.error?.message,
    response?.message,
    typeof response?.error === 'string' ? response.error : null,
  ].find(value => typeof value === 'string' && value)
  if (detail && isContextWindowFailure(new Error(detail))) {
    throw new Error(`Prompt is too long: ${detail}`)
  }
  throw new Error(detail ? String(detail) : 'DeepSeek response failed')
}

export async function relayDeepSeekResponse(res, upstream, trace = null) {
  try {
    const raw = await upstream.text()
    trace?.markFirstByte()
    trace?.addBytes(Buffer.byteLength(raw, 'utf8'))
    trace?.addEvent()
    const response = JSON.parse(raw)
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new Error('DeepSeek returned malformed JSON')
    }
    if (response.type === 'error' || response.error) deepSeekJsonFailure(response)
    if (response.type !== 'message' || !deepSeekJsonHasUsableOutput(response)) {
      throw new Error('DeepSeek returned an empty or malformed response')
    }
    trace?.markOutput()
    trace?.markCompletion()
    json(res, 200, response)
  } catch (error) {
    trace?.markError(error)
    if (isContextWindowFailure(error)) finishAnthropicPromptTooLongError(res, error)
    else anthropicError(res, 502, errorMessage(error))
  }
}

async function handleCodex(body, req, res, modelName, route) {
  const trace = createGatewayTrace({ model: modelName, backend: 'codex', protocol: 'responses' })
  const control = createRequestControl(req, res, trace)
  const querySource = gatewayQuerySource(req)
  const nativeCompaction = isCompactionRequest(req)
  const sessionId = upstreamSessionId(req, body)
  // Null when this machine has no ~/.codex-accounts homes: one CODEX_HOME is
  // then the only account, exactly as before.
  const accounts = await codexRequestPool(sessionId)
  let auth
  try {
    auth = accounts ? await accounts.auth() : await readCodexAuth()
  } catch (error) {
    trace.markError(error)
    anthropicError(res, 401, error instanceof Error ? error.message : 'Codex auth unavailable')
    trace.finish('auth-error', error, 401)
    control.cleanup()
    return
  }
  if (!auth) {
    const message = 'Codex ChatGPT auth is missing or incomplete; run /login codex first'
    trace.markError(new Error(message))
    anthropicError(res, 401, message)
    trace.finish('auth-error', null, 401)
    control.cleanup()
    return
  }

  let request
  try {
    const normalizedBody = normalizeGatewayEffort(body, route, querySource)
    request = anthropicToCodex(normalizedBody, route.upstream, querySource)
    // The Codex Responses endpoint requires SSE even when the Anthropic caller
    // requested a buffered JSON response. Buffering back to JSON happens in
    // relayCodexResponse.
    request.stream = true
    // The current Codex Responses endpoint rejects both max_tokens and
    // max_output_tokens. Keep the caller's cap in the Anthropic contract, but
    // omit the unsupported field from the upstream request.
    delete request.max_output_tokens
    // Compaction is owned by the native harness. The gateway only translates
    // the request protocol; it must not infer or invent a second compaction
    // contract from the prompt contents.
    if (nativeCompaction) {
      process.stderr.write(
        `model-gateway native-compaction source=${safeLogValue(querySource)}\n`,
      )
    }
  } catch (error) {
    trace.markError(error)
    anthropicError(res, 400, error instanceof Error ? error.message : 'Unsupported request')
    trace.finish('invalid-request', error, 400)
    control.cleanup()
    return
  }

  const wantsStream = body.stream === true
  const requests = codexRequestVariants(request, nativeCompaction)
  let requestError = null
  let completed = false

  try {
    let variantIndex = 0
    while (variantIndex < requests.length) {
      const variant = requests[variantIndex]
      if (variantIndex > 0) {
        trace.clearError?.()
        process.stderr.write(
          `model-gateway context-fallback model=${safeLogValue(modelName)} variant=${variantIndex} ${codexRequestShape(variant)}\n`,
        )
      }
      logRequestShape({
        body,
        providerRequest: variant,
        model: modelName,
        backend: 'codex',
        protocol: 'responses',
        querySource,
        variant: variantIndex,
      })

      let responseRetryAttempt = 0
      let advanceVariant = true
      while (true) {
        control.startUpstream()
        let upstream
        try {
          upstream = await fetchWithRetry({
            provider: 'Codex',
            url: CODEX_ENDPOINT,
            // Headers are rebuilt per attempt: a credential failure advances
            // the account pool, and each account carries its own token.
            options: async () => {
              if (accounts) {
                auth = await accounts.auth()
                if (!auth) throw new Error('Codex ChatGPT auth is missing or incomplete; run /login codex first')
              }
              return {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${auth.accessToken}`,
                'chatgpt-account-id': auth.accountId,
                'content-type': 'application/json',
                accept: 'text/event-stream',
                'user-agent': 'gateway-model-gateway/0.1',
              },
              body: JSON.stringify(variant),
              signal: control.signal,
              }
            },
            control,
            trace,
            credentials: accounts ?? undefined,
          })
        } catch (error) {
          requestError = error
          const status = control.statusFor(error)
          anthropicError(res, status, status === 504 ? 'Codex upstream request timed out' : 'Codex connection failed')
          trace.finish('upstream-error', error, status)
          advanceVariant = false
          variantIndex = requests.length
          break
        }

        if (!upstream.ok) {
          const contextFailure = await responseIsContextWindowFailure(upstream)
          const detail = await safeUpstreamResponseError(
            upstream,
            'Codex',
            '',
            {
              signal: control.signal,
              timeoutMs: RETRY_RESPONSE_TIMEOUT_MS,
              onTimeout: error => control.abortUpstream(error),
            },
          )
          await upstream.body?.cancel().catch(() => {})
          if (contextFailure && variantIndex < requests.length - 1) {
            requestError = new Error('Prompt is too long: Codex context window exceeded')
            break
          }
          const status = upstream.status >= 500 ? 502 : upstream.status
          const error = contextFailure
            ? new Error('Prompt is too long: Codex context window exceeded')
            : new Error(detail)
          anthropicError(res, contextFailure ? 400 : status, error.message)
          trace.finish('upstream-http-error', error, contextFailure ? 400 : status)
          advanceVariant = false
          variantIndex = requests.length
          break
        }

        try {
          const throwPreOutput = true
          completed = wantsStream
            ? await relayCodexStream(res, upstream, modelName, trace, control, { throwPreOutput })
            : await relayCodexResponse(res, upstream, modelName, trace, true, control, { throwPreOutput })
          break
        } catch (error) {
          requestError = error
          if (isContextWindowFailure(error) && !res.headersSent && variantIndex < requests.length - 1) {
            break
          }
          if (
            !res.headersSent &&
            retryablePreOutputRelayError(error) &&
            responseRetryAttempt < UPSTREAM_RETRIES
          ) {
            responseRetryAttempt += 1
            const delay = retryDelayMs(responseRetryAttempt, null)
            trace.clearError?.()
            process.stderr.write(
              `model-gateway retry provider=Codex error=pre-output-${safeLogValue(classifyGatewayError(error))} attempt=${responseRetryAttempt} delay_ms=${delay}\n`,
            )
            await waitForRetry(delay, control.signal)
            continue
          }
          if (!res.headersSent) {
            if (isContextWindowFailure(error)) {
              finishAnthropicPromptTooLongError(res, error)
            } else {
              anthropicError(res, 502, error instanceof Error ? error.message : 'Codex request failed')
            }
          } else if (wantsStream) {
            process.stderr.write(
              `model-gateway codex-stream-error model=${safeLogValue(modelName)} class=${safeLogValue(classifyGatewayError(error))}\n`,
            )
            finishAnthropicStreamWithError(res, error)
          }
          advanceVariant = false
          variantIndex = requests.length
          break
        }
      }

      if (completed) break
      if (variantIndex < requests.length - 1 && advanceVariant) {
        variantIndex += 1
      } else if (variantIndex < requests.length) {
        variantIndex += 1
      }
    }

    if (!completed && !res.headersSent && requestError) {
      anthropicError(res, isContextWindowFailure(requestError) ? 400 : 502, errorMessage(requestError))
    }
    if (!trace.finished) {
      trace.finish(
        completed || res.statusCode === 200 ? 'success' : 'error',
        requestError,
        res.statusCode,
      )
    }
  } catch (error) {
    requestError ||= error
    trace.markError(error)
    // A downstream disconnect can abort a retry backoff or an in-flight
    // fetch. That is expected request cancellation, not a gateway crash.
    // Never attempt to write a second response after the client is gone.
    if (!control.signal.aborted && !res.headersSent && !res.destroyed && !res.writableEnded) {
      anthropicError(res, 502, error instanceof Error ? error.message : 'Codex request failed')
    } else if (
      !control.signal.aborted &&
      res.headersSent &&
      wantsStream &&
      !res.destroyed &&
      !res.writableEnded
    ) {
      finishAnthropicStreamWithError(res, error)
    }
    if (!trace.finished) {
      trace.finish(
        control.signal.aborted ? 'cancelled' : 'request-error',
        error,
        res.statusCode,
      )
    }
  } finally {
    control.cleanup()
  }
}

async function handleOpenCodeGo(body, req, res, modelName, route) {
  const wantsStream = body.stream === true
  const sessionId = upstreamSessionId(req, body)
  const trace = createGatewayTrace({ model: modelName, backend: 'opencode-go', protocol: route.protocol })
  const control = createRequestControl(req, res, trace)
  const querySource = gatewayQuerySource(req)
  const credentials = await sessionOpenCodeCredentials(sessionId)
  let apiKey = credentials.key
  if (!apiKey) {
    anthropicError(res, 401, 'OpenCode Go API key is not configured')
    trace.finish('auth-error', null, 401)
    control.cleanup()
    return
  }

  let request
  try {
    const toolSafeBody = stripUnsupportedOpenCodeToolChoice(
      stripUnsupportedOpenCodeTools(body, route),
      route,
    )
    const normalizedBody = normalizeGatewayEffort(toolSafeBody, route, querySource)
    // The native harness owns compaction semantics, including tool denial and
    // summary construction. OpenCode receives the same request shape as any
    // other turn; only provider capability adapters may alter it.
    if (isCompactionRequest(req)) {
      process.stderr.write(
        `model-gateway native-compaction source=${safeLogValue(querySource)}\n`,
      )
    }
    request = anthropicToOpenCodeRequest(normalizedBody, route, querySource)
    logRequestShape({
      body: normalizedBody,
      providerRequest: request,
      model: modelName,
      backend: 'opencode-go',
      protocol: route.protocol,
      querySource,
    })
  } catch (error) {
    anthropicError(res, 400, error instanceof Error ? error.message : 'Unsupported request')
    trace.finish('invalid-request', error, 400)
    control.cleanup()
    return
  }

  try {
    let relayAttempt = 0
    while (true) {
      let upstream
      control.startUpstream()
      try {
        upstream = await fetchWithRetry({
          provider: 'OpenCode Go',
          url: openCodeGoEndpoint(route.protocol),
          options: () => {
            apiKey = credentials.key
            return {
              method: 'POST',
              headers: openCodeGoHeaders(route.protocol, apiKey, wantsStream, sessionId),
              body: JSON.stringify(request),
              signal: control.signal,
            }
          },
          control,
          trace,
          credentials,
        })
      } catch (error) {
        trace.markError(error)
        const status = control.statusFor(error)
        anthropicError(res, status, status === 504 ? 'OpenCode Go upstream request timed out' : 'OpenCode Go connection failed')
        trace.finish('upstream-error', error, status)
        return
      }

      if (!upstream.ok) {
        const detail = await safeUpstreamResponseError(
          upstream,
          'OpenCode Go',
          apiKey,
          {
            signal: control.signal,
            timeoutMs: RETRY_RESPONSE_TIMEOUT_MS,
            onTimeout: error => control.abortUpstream(error),
          },
        )
        await upstream.body?.cancel().catch(() => {})
        const contextFailure = upstream.status === 400 &&
          isContextWindowFailure(new Error(detail))
        const status = contextFailure
          ? 400
          : upstream.status >= 500
            ? 502
            : upstream.status
        if (contextFailure) {
          finishAnthropicPromptTooLongError(res, new Error(detail))
        } else {
          anthropicError(res, status, detail)
        }
        trace.finish('upstream-http-error', null, status)
        return
      }

      try {
        const relayOptions = {
          signal: control.signal,
          throwPreOutput: true,
        }
        if (wantsStream) {
          await relayOpenCodeStream(res, upstream, modelName, route.protocol, trace, relayOptions)
        } else {
          await relayOpenCodeResponseByProtocol(res, upstream, modelName, route.protocol, trace, relayOptions)
        }
        break
      } catch (error) {
        if (
          !res.headersSent &&
          !control.signal.aborted &&
          retryablePreOutputRelayError(error) &&
          relayAttempt < UPSTREAM_RETRIES
        ) {
          relayAttempt += 1
          credentials.advance()
          const delay = retryDelayMs(relayAttempt, null)
          trace.clearError?.()
          process.stderr.write(
            `model-gateway retry provider=OpenCode-Go error=pre-output-${safeLogValue(classifyGatewayError(error))} attempt=${relayAttempt} delay_ms=${delay}\n`,
          )
          await waitForRetry(delay, control.signal)
          continue
        }
        if (!res.headersSent) {
          if (isContextWindowFailure(error)) finishAnthropicPromptTooLongError(res, error)
          else anthropicError(res, 502, credentials.redact(errorMessage(error)))
        } else if (wantsStream) {
          finishAnthropicStreamWithError(res, error)
        }
        break
      }
    }
    trace.finish(res.headersSent && res.statusCode === 200 ? 'success' : 'error', null, res.statusCode)
  } catch (error) {
    trace.markError(error)
    if (!res.headersSent) {
      anthropicError(res, 502, credentials.redact(error instanceof Error ? error.message : 'OpenCode Go request failed'))
    } else if (wantsStream) {
      finishAnthropicStreamWithError(res, error)
    }
    trace.finish('request-error', error, res.statusCode)
  } finally {
    control.cleanup()
  }
}

async function handleCommandCode(body, req, res, modelName, route) {
  const wantsStream = body.stream === true
  const sessionId = upstreamSessionId(req, body)
  const trace = createGatewayTrace({ model: modelName, backend: 'commandcode', protocol: route.protocol })
  const control = createRequestControl(req, res, trace)
  const querySource = gatewayQuerySource(req)
  const credentials = await ensureCommandCodePreference(sessionId)
  let apiKey = credentials.key
  if (!apiKey) {
    anthropicError(res, 401, 'Command Code API key is not configured')
    trace.finish('auth-error', null, 401)
    control.cleanup()
    return
  }

  let request
  try {
    const toolSafeBody = stripUnsupportedOpenCodeToolChoice(
      stripUnsupportedOpenCodeTools(body, route),
      route,
    )
    const normalizedBody = normalizeGatewayEffort(toolSafeBody, route, querySource)
    request = anthropicToOpenCodeRequest(normalizedBody, route, querySource)
    logRequestShape({
      body: normalizedBody,
      providerRequest: request,
      model: modelName,
      backend: 'commandcode',
      protocol: route.protocol,
      querySource,
    })
  } catch (error) {
    anthropicError(res, 400, error instanceof Error ? error.message : 'Unsupported request')
    trace.finish('invalid-request', error, 400)
    control.cleanup()
    return
  }

  try {
    let relayAttempt = 0
    while (true) {
      let upstream
      control.startUpstream()
      try {
        upstream = await fetchWithRetry({
          provider: 'Command Code',
          url: commandCodeEndpoint(),
          options: () => {
            apiKey = credentials.key
            return {
              method: 'POST',
              headers: commandCodeHeaders(apiKey, wantsStream),
              body: JSON.stringify(request),
              signal: control.signal,
            }
          },
          control,
          trace,
          credentials,
        })
      } catch (error) {
        trace.markError(error)
        const status = control.statusFor(error)
        anthropicError(res, status, control.signal.aborted ? 'Command Code upstream request timed out' : 'Command Code connection failed')
        trace.finish('upstream-error', error, status)
        return
      }

      if (!upstream.ok) {
        const detail = await safeUpstreamResponseError(
          upstream,
          'Command Code',
          apiKey,
          {
            signal: control.signal,
            timeoutMs: RETRY_RESPONSE_TIMEOUT_MS,
            onTimeout: error => control.abortUpstream(error),
          },
        )
        await upstream.body?.cancel().catch(() => {})
        const status = upstream.status >= 500 ? 502 : upstream.status
        anthropicError(res, status, detail)
        trace.finish('upstream-http-error', null, status)
        return
      }

      try {
        const relayOptions = { signal: control.signal, throwPreOutput: true }
        if (wantsStream) {
          await relayOpenCodeStream(res, upstream, modelName, route.protocol, trace, relayOptions)
        } else {
          await relayOpenCodeResponseByProtocol(res, upstream, modelName, route.protocol, trace, relayOptions)
        }
        break
      } catch (error) {
        if (
          !res.headersSent &&
          !control.signal.aborted &&
          retryablePreOutputRelayError(error) &&
          relayAttempt < UPSTREAM_RETRIES
        ) {
          relayAttempt += 1
          credentials.advance()
          const delay = retryDelayMs(relayAttempt, null)
          trace.clearError?.()
          process.stderr.write(
            `model-gateway retry provider=Command-Code error=pre-output-${safeLogValue(classifyGatewayError(error))} attempt=${relayAttempt} delay_ms=${delay}\n`,
          )
          await waitForRetry(delay, control.signal)
          continue
        }
        if (!res.headersSent) {
          anthropicError(res, 502, credentials.redact(errorMessage(error)))
        } else if (wantsStream) {
          finishAnthropicStreamWithError(res, error)
        }
        break
      }
    }
    trace.finish(res.headersSent && res.statusCode === 200 ? 'success' : 'error', null, res.statusCode)
  } catch (error) {
    trace.markError(error)
    if (!res.headersSent) {
      anthropicError(res, 502, credentials.redact(error instanceof Error ? error.message : 'Command Code request failed'))
    } else if (wantsStream) {
      finishAnthropicStreamWithError(res, error)
    }
    trace.finish('request-error', error, res.statusCode)
  } finally {
    control.cleanup()
  }
}

async function handleMistral(body, req, res, modelName, route) {
  const wantsStream = body.stream === true
  const sessionId = upstreamSessionId(req, body)
  const trace = createGatewayTrace({ model: modelName, backend: 'mistral', protocol: route.protocol })
  const control = createRequestControl(req, res, trace)
  const querySource = gatewayQuerySource(req)
  const apiPool = await ensureMistralPreference(sessionId)
  // The route names the budget: `vibe` spends only Vibe plan keys, `api` only
  // Studio API keys. The unsuffixed legacy route keeps Vibe-first fallback.
  const credentials =
    route.mistralCredential === 'api'
      ? apiPool
      : route.mistralCredential === 'vibe'
        ? mistralVibeCredentials
        : mistralRouteCredentials(apiPool)
  let apiKey = credentials.key
  if (!apiKey) {
    anthropicError(res, 401, 'Mistral API key is not configured')
    trace.finish('auth-error', null, 401)
    control.cleanup()
    return
  }

  let request
  try {
    const toolSafeBody = stripUnsupportedOpenCodeToolChoice(
      stripUnsupportedOpenCodeTools(body, route),
      route,
    )
    const normalizedBody = normalizeGatewayEffort(toolSafeBody, route, querySource)
    request = anthropicToMistralChat(normalizedBody, route.upstream, querySource)
    logRequestShape({
      body: normalizedBody,
      providerRequest: request,
      model: modelName,
      backend: 'mistral',
      protocol: route.protocol,
      querySource,
    })
  } catch (error) {
    anthropicError(res, 400, error instanceof Error ? error.message : 'Unsupported request')
    trace.finish('invalid-request', error, 400)
    control.cleanup()
    return
  }

  try {
    let relayAttempt = 0
    while (true) {
      let upstream
      control.startUpstream()
      try {
        upstream = await fetchWithRetry({
          provider: 'Mistral',
          url: mistralEndpoint(),
          options: () => {
            apiKey = credentials.key
            return {
              method: 'POST',
              headers: mistralHeaders(apiKey, wantsStream),
              body: JSON.stringify(request),
              signal: control.signal,
            }
          },
          control,
          trace,
          credentials,
        })
      } catch (error) {
        trace.markError(error)
        const status = control.statusFor(error)
        anthropicError(res, status, control.signal.aborted ? 'Mistral upstream request timed out' : 'Mistral connection failed')
        trace.finish('upstream-error', error, status)
        return
      }

      if (!upstream.ok) {
        const detail = await safeUpstreamResponseError(
          upstream,
          'Mistral',
          apiKey,
          {
            signal: control.signal,
            timeoutMs: RETRY_RESPONSE_TIMEOUT_MS,
            onTimeout: error => control.abortUpstream(error),
          },
        )
        await upstream.body?.cancel().catch(() => {})
        const status = upstream.status >= 500 ? 502 : upstream.status
        anthropicError(res, status, detail)
        trace.finish('upstream-http-error', null, status)
        return
      }

      try {
        const relayOptions = { signal: control.signal, throwPreOutput: true }
        if (wantsStream) {
          await relayOpenCodeStream(res, upstream, modelName, route.protocol, trace, relayOptions)
        } else {
          await relayOpenCodeResponseByProtocol(res, upstream, modelName, route.protocol, trace, relayOptions)
        }
        break
      } catch (error) {
        if (
          !res.headersSent &&
          !control.signal.aborted &&
          retryablePreOutputRelayError(error) &&
          relayAttempt < UPSTREAM_RETRIES
        ) {
          relayAttempt += 1
          credentials.advance()
          const delay = retryDelayMs(relayAttempt, null)
          trace.clearError?.()
          process.stderr.write(
            `model-gateway retry provider=Mistral error=pre-output-${safeLogValue(classifyGatewayError(error))} attempt=${relayAttempt} delay_ms=${delay}\n`,
          )
          await waitForRetry(delay, control.signal)
          continue
        }
        if (!res.headersSent) {
          anthropicError(res, 502, credentials.redact(errorMessage(error)))
        } else if (wantsStream) {
          finishAnthropicStreamWithError(res, error)
        }
        break
      }
    }
    trace.finish(res.headersSent && res.statusCode === 200 ? 'success' : 'error', null, res.statusCode)
  } catch (error) {
    trace.markError(error)
    if (!res.headersSent) {
      anthropicError(res, 502, credentials.redact(error instanceof Error ? error.message : 'Mistral request failed'))
    } else if (wantsStream) {
      finishAnthropicStreamWithError(res, error)
    }
    trace.finish('request-error', error, res.statusCode)
  } finally {
    control.cleanup()
  }
}

async function handleOpenCodeZen(body, req, res, modelName, route) {
  const wantsStream = body.stream === true
  const sessionId = upstreamSessionId(req, body)
  const trace = createGatewayTrace({ model: modelName, backend: 'opencode-zen', protocol: route.protocol })
  const control = createRequestControl(req, res, trace)
  const querySource = gatewayQuerySource(req)
  const credentials = await sessionOpenCodeCredentials(sessionId)
  let apiKey = credentials.key
  if (!apiKey) {
    anthropicError(res, 401, 'OpenCode Zen API key is not configured')
    trace.finish('auth-error', null, 401)
    control.cleanup()
    return
  }

  let request
  try {
    const toolSafeBody = stripUnsupportedOpenCodeToolChoice(
      stripUnsupportedOpenCodeTools(body, route),
      route,
    )
    const normalizedBody = normalizeGatewayEffort(toolSafeBody, route, querySource)
    request = anthropicToOpenCodeRequest(normalizedBody, route, querySource)
    request = ensureOpenCodeZenReadTool(request, route.protocol, route.supportsTools !== false)
    // `stream: true` is one of the four factors the free-tier fingerprint
    // checks, and it is a property of the request we send upstream rather than
    // of what the caller asked for: a caller that wanted a single JSON body
    // still has an SSE request made on its behalf, and the collector relay
    // folds the stream back into that single body.
    request = { ...request, stream: true }
    logRequestShape({
      body: normalizedBody,
      providerRequest: request,
      model: modelName,
      backend: 'opencode-zen',
      protocol: route.protocol,
      querySource,
    })
  } catch (error) {
    anthropicError(res, 400, error instanceof Error ? error.message : 'Unsupported request')
    trace.finish('invalid-request', error, 400)
    control.cleanup()
    return
  }

  try {
    control.startUpstream()
    const upstream = await fetchWithRetry({
      provider: 'OpenCode Zen',
      url: openCodeZenEndpoint(route.protocol),
      options: () => {
        apiKey = credentials.key
        return {
          method: 'POST',
          // The upstream request is always an SSE one (see `request.stream`
          // above), so the response type announced to the provider is always
          // the event stream.
          headers: openCodeZenHeaders(apiKey, true, sessionId),
          body: JSON.stringify(request),
          signal: control.signal,
        }
      },
      control,
      trace,
      credentials,
    })
    if (!upstream.ok) {
      const detail = await safeUpstreamResponseError(
        upstream,
        'OpenCode Zen',
        apiKey,
        { signal: control.signal, timeoutMs: RETRY_RESPONSE_TIMEOUT_MS },
      )
      await upstream.body?.cancel().catch(() => {})
      const status = upstream.status >= 500 ? 502 : upstream.status
      anthropicError(res, status, detail)
      trace.finish('upstream-http-error', null, status)
      return
    }

    const relayOptions = { signal: control.signal, throwPreOutput: true }
    if (wantsStream) {
      await relayOpenCodeStream(res, upstream, modelName, route.protocol, trace, relayOptions)
    } else {
      await relayOpenCodeCollectedResponse(res, upstream, modelName, route.protocol, trace, relayOptions)
    }
    trace.finish(res.headersSent && res.statusCode === 200 ? 'success' : 'error', null, res.statusCode)
  } catch (error) {
    trace.markError(error)
    if (!res.headersSent) {
      const status = control.statusFor(error)
      anthropicError(res, status, control.signal.aborted ? 'OpenCode Zen upstream request timed out' : credentials.redact(errorMessage(error)))
    } else if (wantsStream) {
      finishAnthropicStreamWithError(res, error)
    }
    trace.finish('request-error', error, res.statusCode)
  } finally {
    control.cleanup()
  }
}

// A passthrough provider that cannot present credentials refuses the request
// locally. The status is carried on the error because the same failure means
// "sign in again" (401) or "the provider is unreachable" (502) depending on
// where it happened.
class PassthroughCredentialError extends Error {
  constructor(message, status = 401) {
    super(message)
    this.name = 'PassthroughCredentialError'
    this.status = status
  }
}

// The caller's own headers minus everything hop-by-hop, and in particular
// minus the Gateway's Authorization header: the Gateway token authenticates the
// client to this process and must never reach a provider.
function passthroughCopyHeaders(req, stream = false) {
  const hopByHop = new Set([
    'connection',
    'content-length',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'x-api-key',
    'authorization',
    'accept',
  ])
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value == null || hopByHop.has(name.toLowerCase())) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  headers.set('accept', stream ? 'text/event-stream' : 'application/json')
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  return headers
}

function apiKeyHeaders(req, apiKey, stream = false) {
  const headers = passthroughCopyHeaders(req, stream)
  headers.set('x-api-key', apiKey)
  return headers
}

function anthropicCredentialsPath(home = null) {
  // An account home holds `credentials.json`; the legacy single sign-in lives
  // at the CLI's `.credentials.json`.
  if (home) return anthropicAccountCredentialPath(home)
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, '.credentials.json')
}

function anthropicExpiresAt(oauth) {
  return typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : 0
}

// The subscription credential, read from the same file the CLI maintains. Null
// means nothing usable is stored, so the caller refuses rather than forwarding
// an unauthenticated request.
async function readAnthropicCredential(filePath = anthropicCredentialsPath()) {
  try {
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'))
    const oauth = stored?.claudeAiOauth
    if (
      !oauth ||
      typeof oauth.accessToken !== 'string' ||
      typeof oauth.refreshToken !== 'string'
    ) {
      return null
    }
    return { stored, oauth }
  } catch {
    return null
  }
}

// Exactly one refresh may be in flight *per credential file*: the provider's
// refresh tokens are single-use, so concurrent turns that each exchanged one
// would invalidate the other's result. Keyed by file because each account home
// is an independent grant.
const anthropicRefreshesInFlight = new Map()

function mergeAnthropicBetas(existing, required) {
  const values = []
  for (const raw of [existing, required]) {
    for (const part of String(raw ?? '').split(',')) {
      const value = part.trim()
      if (value && !values.includes(value)) values.push(value)
    }
  }
  return values.join(',')
}

async function refreshAnthropicCredential(credential, filePath = anthropicCredentialsPath()) {
  const { oauth } = credential
  let response
  try {
    response = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
        // The backend allows scope expansion on refresh, so the full Claude AI
        // set is requested rather than only what the stored grant carried.
        scope: ANTHROPIC_OAUTH_SCOPES,
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new PassthroughCredentialError(
      `Anthropic credential refresh failed: ${errorMessage(error)}`,
      502,
    )
  }
  if (!response.ok) {
    // A rejected grant means the stored sign-in is finished; anything else is
    // the provider having a bad moment.
    const status = response.status === 400 || response.status === 401 ? 401 : 502
    throw new PassthroughCredentialError(
      status === 401
        ? 'Anthropic sign-in is no longer valid; sign in again with Claude Code'
        : `Anthropic credential refresh failed with HTTP ${response.status}`,
      status,
    )
  }
  let tokens
  try {
    tokens = await response.json()
  } catch (error) {
    throw new PassthroughCredentialError(
      `Anthropic credential refresh returned an unreadable body: ${errorMessage(error)}`,
      502,
    )
  }
  if (typeof tokens?.access_token !== 'string' || tokens.access_token === '') {
    throw new PassthroughCredentialError(
      'Anthropic credential refresh returned no access token',
      502,
    )
  }
  const refreshed = {
    accessToken: tokens.access_token,
    refreshToken:
      typeof tokens.refresh_token === 'string' && tokens.refresh_token !== ''
        ? tokens.refresh_token
        : oauth.refreshToken,
    expiresAt:
      typeof tokens.expires_in === 'number'
        ? Date.now() + tokens.expires_in * 1000
        : Date.now() + 3_600_000,
  }
  await persistAnthropicCredential(credential, refreshed, filePath)
  return refreshed.accessToken
}

// Write the rotated token back the way the CLI stores it: whole file replaced
// through a same-directory temp file, so a reader never sees a partial
// credential. A refresh token that changed on disk meanwhile came from another
// writer that already rotated the pair, and is left alone.
async function persistAnthropicCredential(credential, refreshed, filePath = anthropicCredentialsPath()) {
  const target = filePath
  const current = await readAnthropicCredential(filePath)
  if (!current || current.oauth.refreshToken !== credential.oauth.refreshToken) return
  current.stored.claudeAiOauth = {
    ...current.stored.claudeAiOauth,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
  }
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(temporary, 'w', 0o600)
    try {
      await handle.writeFile(JSON.stringify(current.stored))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, target)
  } catch (error) {
    // A credential that could not be persisted is still usable for this turn.
    await fs.rm(temporary, { force: true }).catch(() => {})
    process.stderr.write(
      `model-gateway warning: could not persist refreshed Anthropic credential: ${errorMessage(error)}\n`,
    )
  }
}

// ---------------------------------------------------------------------------
// Claude accounts: each home under ~/.claude-accounts is one Anthropic
// subscription. Same contract as the Codex pool - stable numbers, a session pin
// or the global current.txt, one live pool per session, and an advance past an
// account that cannot serve. A machine with no account homes keeps reading the
// single CLI credential file.
// ---------------------------------------------------------------------------

/** Explicit per-session pins, as set by /login claude switch … session. */
const anthropicSessionSelections = new Map()
/** One live pool per session, so a failover sticks for that session. */
const anthropicPools = new Map()

async function anthropicLoadedAccounts() {
  try {
    return await anthropicAccounts()
  } catch {
    return []
  }
}

function anthropicPoolEnabled() {
  return process.env.ANTHROPIC_ACCOUNT_POOL !== 'off'
}

function anthropicPoolSignature(accounts) {
  return accounts.map(account => `${account.number}:${account.name}:${account.home}`).join(',')
}

function buildAnthropicPool(accounts, preferred) {
  let selected = preferred
  let lastServed = null
  const at = number => accounts.findIndex(account => account.number === number)
  const pool = {
    get accounts() {
      return accounts.map(account => ({
        number: account.number,
        name: account.name,
        ...(account.email ? { email: account.email } : {}),
        ...(account.displayName ? { displayName: account.displayName } : {}),
      }))
    },
    get numbers() { return accounts.map(account => account.number) },
    get size() { return accounts.length },
    get number() {
      const index = at(selected)
      return index < 0 ? accounts[0].number : accounts[index].number
    },
    get lastServed() { return lastServed },
    nameFor(number) { return accounts.find(account => account.number === number)?.name ?? null },
    emailFor(number) { return accounts.find(account => account.number === number)?.email ?? null },
    accountFor(number) { return accounts.find(account => account.number === number) ?? null },
    pathFor(number) {
      const account = accounts.find(candidate => candidate.number === number)
      return account ? anthropicCredentialsPath(account.home) : null
    },
    advance() {
      const index = at(selected)
      if (index < 0) return
      selected = accounts[(index + 1) % accounts.length].number
    },
    select(number) {
      if (!accounts.some(account => account.number === number)) return false
      selected = number
      return true
    },
    markServed() { lastServed = pool.number },
  }
  return pool
}

export async function anthropicRequestPool(sessionId) {
  if (!anthropicPoolEnabled()) return null
  const accounts = await anthropicLoadedAccounts()
  const key = sessionId || ''
  if (accounts.length === 0) {
    anthropicPools.delete(key)
    return null
  }
  const signature = anthropicPoolSignature(accounts)
  const cached = anthropicPools.get(key)
  if (cached?.signature === signature) return cached.pool
  const selectedName = await currentAnthropicAccountName()
  const selected = accounts.find(account => account.name === selectedName)
  const pinned = sessionId ? anthropicSessionSelections.get(sessionId) : undefined
  const carried = cached?.pool.number
  const preferred = Number.isSafeInteger(pinned) && accounts.some(account => account.number === pinned)
    ? pinned
    : accounts.some(account => account.number === carried)
      ? carried
      : selected?.number ?? accounts[0].number
  const pool = buildAnthropicPool(accounts, preferred)
  anthropicPools.set(key, { signature, pool })
  return pool
}

/**
 * The credential file a request outside any session should use: the global
 * selection, or the CLI's own file when no account homes exist. Usage/quota
 * reads use this, so the reported windows belong to the account in use.
 */
async function anthropicSelectedPath() {
  if (!anthropicPoolEnabled()) return anthropicCredentialsPath()
  const accounts = await anthropicLoadedAccounts()
  if (accounts.length === 0) return anthropicCredentialsPath()
  const selectedName = await currentAnthropicAccountName()
  const selected = accounts.find(account => account.name === selectedName) ?? accounts[0]
  return anthropicCredentialsPath(selected.home)
}

function anthropicPoolPath(pool) {
  if (!pool) return null
  return pool.pathFor(pool.number)
}

/**
 * One refresher per credential file across processes.
 *
 * Anthropic refresh tokens are single-use, so a gateway and a CLI refreshing
 * the same account concurrently would invalidate each other. The lock is a
 * sibling `.lock` file created exclusively; a stale one (a crashed process) is
 * broken after 30s, and a waiter that cannot get in within 20s proceeds anyway
 * - the re-read inside the lock then either finds the winner's rotated token or
 * refreshes that one, so the common case degrades to an extra refresh rather
 * than a broken sign-in.
 */
export async function withAnthropicRefreshLock(filePath, work) {
  const lockPath = `${filePath}.lock`
  const deadline = Date.now() + 20_000
  let handle = null
  while (!handle) {
    try {
      handle = await fs.open(lockPath, 'wx', 0o600)
    } catch (error) {
      if (error?.code !== 'EEXIST') return work()
      try {
        const info = await fs.stat(lockPath)
        if (Date.now() - info.mtimeMs > 30_000) {
          await fs.rm(lockPath, { force: true })
          continue
        }
      } catch {}
      if (Date.now() > deadline) return work()
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n`).catch(() => {})
    return await work()
  } finally {
    await handle.close().catch(() => {})
    await fs.rm(lockPath, { force: true }).catch(() => {})
  }
}

async function refreshAnthropicCredentialLocked(credential, filePath) {
  return withAnthropicRefreshLock(filePath, async () => {
    const latest = await readAnthropicCredential(filePath)
    // Another process rotated the pair while this one waited: its token is the
    // live one and this grant must not be exchanged a second time.
    if (latest && latest.oauth.refreshToken !== credential.oauth.refreshToken) {
      if (anthropicExpiresAt(latest.oauth) > Date.now() + 60_000) return latest.oauth.accessToken
      return refreshAnthropicCredential(latest, filePath)
    }
    return refreshAnthropicCredential(credential, filePath)
  })
}

async function anthropicAccessToken(filePath = null) {
  const target = filePath ?? await anthropicSelectedPath()
  const credential = await readAnthropicCredential(target)
  if (!credential) {
    throw new PassthroughCredentialError(
      'Anthropic credentials are not configured: sign in with Claude Code, or set ANTHROPIC_API_KEY',
    )
  }
  const { oauth } = credential
  if (anthropicExpiresAt(oauth) > Date.now() + 60_000) return oauth.accessToken
  const inFlight = anthropicRefreshesInFlight.get(target)
  if (inFlight) return inFlight
  const refresh = refreshAnthropicCredentialLocked(credential, target).finally(() => {
    if (anthropicRefreshesInFlight.get(target) === refresh) {
      anthropicRefreshesInFlight.delete(target)
    }
  })
  anthropicRefreshesInFlight.set(target, refresh)
  return refresh
}

async function anthropicHeaders(req, { stream, body, pool = null }) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const credentialPath = anthropicPoolPath(pool)
  const token = apiKey ? null : await anthropicAccessToken(credentialPath)
  const headers = passthroughCopyHeaders(req, stream)
  if (apiKey) {
    headers.set('x-api-key', apiKey)
  } else {
    headers.set('authorization', `Bearer ${token}`)
    headers.set('x-app', 'cli')
  }
  headers.set('anthropic-version', '2023-06-01')
  // Load-bearing: the endpoint gates model availability on the reported client
  // version, so the caller's own user-agent is never forwarded.
  headers.set('user-agent', ANTHROPIC_USER_AGENT)
  const effort = body?.output_config?.effort ?? body?.reasoning?.effort ?? null
  headers.set(
    'anthropic-beta',
    // The caller already sends its own beta list; this only ever adds to it.
    mergeAnthropicBetas(
      headers.get('anthropic-beta'),
      [
        apiKey ? null : 'oauth-2025-04-20',
        'claude-code-20250219',
        effort != null ? 'effort-2025-11-24' : null,
      ]
        .filter(Boolean)
        .join(','),
    ),
  )
  return { headers, secret: apiKey || token }
}

// Providers that speak the Anthropic Messages protocol verbatim: the request
// body is forwarded unchanged apart from effort normalization, and the reply is
// relayed as-is. DeepSeek and AMD Radeon Cloud both fit, so they share this path
// rather than maintaining two copies of the same relay. Anthropic itself joins
// them, with subscription OAuth credentials in place of a static key.
const ANTHROPIC_PASSTHROUGH_PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    endpoint: DEEPSEEK_ENDPOINT,
    backend: 'deepseek',
    // Numbered keys rotate like every other provider: a rejected key hands the
    // retry to the next one instead of failing the turn.
    pool: sessionDeepSeekCredentials,
    headers: (req, { stream, pool }) => {
      const apiKey = pool?.key ?? process.env.DEEPSEEK_API_KEY
      if (!apiKey) {
        throw new PassthroughCredentialError('DeepSeek API key is not configured')
      }
      return { headers: apiKeyHeaders(req, apiKey, stream), secret: apiKey }
    },
  },
  'amd-radeon': {
    label: 'AMD Radeon',
    endpoint: AMD_RADEON_ENDPOINT,
    backend: 'amd-radeon',
    headers: (req, { stream }) => {
      const apiKey = process.env.AMD_API_KEY
      if (!apiKey) {
        throw new PassthroughCredentialError('AMD Radeon API key is not configured')
      }
      return { headers: apiKeyHeaders(req, apiKey, stream), secret: apiKey }
    },
  },
  anthropic: {
    label: 'Anthropic',
    endpoint: ANTHROPIC_ENDPOINT,
    backend: 'anthropic',
    pool: anthropicRequestPool,
    headers: (req, context) => anthropicHeaders(req, context),
  },
}

const OPENCODE_USAGE_ENDPOINT =
  process.env.MODEL_GATEWAY_OPENCODE_USAGE_URL ||
  'https://opencode.ai/zen/go/v1/usage'

/**
 * The subscription's windows as `{ H?, W?, M? }` of `{ usedPercent, resetsAt }`.
 * `rolling` is the short window (the gateway's `H`), `weekly` the weekly one,
 * `monthly` the monthly cap. `percent` is already used 0-100 - the same scale
 * the footer prints - and `resetsAt` is an ISO timestamp.
 */
function openCodeUsageWindows(payload) {
  const windows = {}
  for (const [name, kind] of [['rolling', 'H'], ['weekly', 'W'], ['monthly', 'M']]) {
    const window = payload?.usage?.[name]
    const used = clampUsedPercent(window?.percent)
    if (used === null) continue
    windows[kind] = { usedPercent: used, resetsAt: resetToEpochMs(window?.resetsAt) }
  }
  return windows
}

/**
 * The OpenCode subscription's own usage, normalized to the shared ProviderQuota
 * shape and shared across gateways through the quota cache (one account, so the
 * key is the account NUMBER, not the credential).
 *
 * The figure belongs to the account that is actually serving, which is the
 * pool's `lastServed` when a turn has answered and its selected number
 * otherwise - the preference file can re-select a different key between turns,
 * so the selected number alone would describe the wrong account.
 */
export async function readOpenCodeSubscriptionUsage(credentials = openCodeCredentials, endpoint = OPENCODE_USAGE_ENDPOINT) {
  const number = Number.isSafeInteger(credentials.lastServed) && credentials.lastServed > 0
    ? credentials.lastServed
    : credentials.number
  const key = credentials.keyFor ? credentials.keyFor(number) : credentials.key
  if (!key) return { windows: {}, asof: Date.now(), stale: true }
  const payload = await readQuotaThroughCache({
    key: quotaKey('opencode', number),
    ttlMs: QUOTA_TTL_MS.opencode,
    read: async () => {
      try {
        const response = await fetch(endpoint, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(5_000),
        })
        // A non-OK reply is a failure, not an empty account: returning the last
        // good figure stale beats telling the footer there is no limit.
        if (!response.ok) return { windows: null }
        return { windows: openCodeUsageWindows(await response.json()), account: number }
      } catch {
        return { windows: null }
      }
    },
  })
  // Nothing good has ever been read for this account, so there is no figure to
  // report - an empty window set, not a crash.
  if (!payload) return { windows: {}, asof: Date.now(), stale: true }
  return payload
}

// ---------------------------------------------------------------------------
// Command Code usage.
//
// Command Code reports three windows: a five-hour cap, a weekly cap, and a
// monthly credit grant. The first two come straight from
// `/alpha/billing/credits` as `used`/`cap`; the monthly figure is the plan's
// grant minus what is left (`credits.monthlyCredits`), which is how the CLI
// itself derives it. The plan id comes from `/alpha/billing/subscriptions`, and
// an unrecognised plan leaves the monthly window out rather than inventing a
// total it cannot know.
// ---------------------------------------------------------------------------
const COMMANDCODE_API_BASE =
  process.env.MODEL_GATEWAY_COMMANDCODE_API_BASE || 'https://api.commandcode.ai'

const COMMANDCODE_PLAN_TOTALS = {
  'individual-go': 10,
  'individual-go-v1': 10,
  'individual-goat': 70,
  'individual-pro': 30,
  'individual-pro-v1': 80,
  'individual-provider': 15,
  'individual-max': 150,
  'individual-ultra': 300,
  'teams-pro': 40,
}

/** One `{ used, cap, resetAt }` bucket as a normalized quota window. */
function commandCodeWindow(window) {
  if (!window || typeof window !== 'object') return null
  const used = Number(window.used)
  const cap = Number(window.cap)
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return null
  return {
    usedPercent: clampUsedPercent((used / cap) * 100),
    resetsAt: resetToEpochMs(window.resetAt),
  }
}

/**
 * The account's windows from the credits reply and the plan the subscription
 * names. Exported so the normalization can be tested without a server.
 */
export function commandCodeUsageWindows(creditsPayload, planId, periodEnd = null) {
  const windows = {}
  const hour = commandCodeWindow(creditsPayload?.windowLimits?.fiveHour)
  if (hour) windows.H = hour
  const week = commandCodeWindow(creditsPayload?.windowLimits?.weekly)
  if (week) windows.W = week

  const granted = COMMANDCODE_PLAN_TOTALS[planId]
  const monthlyRemaining = Number(creditsPayload?.credits?.monthlyCredits)
  if (Number.isFinite(granted) && granted > 0 && Number.isFinite(monthlyRemaining)) {
    const purchased = Number(creditsPayload?.credits?.purchasedCredits) || 0
    const free = Number(creditsPayload?.credits?.freeCredits) || 0
    const remaining = Math.max(0, monthlyRemaining) + purchased + free
    // The grant can be topped up mid-period, so the total is whichever is
    // larger; only the difference is usage.
    const total = Math.max(granted, monthlyRemaining) + purchased + free
    const used = Math.max(0, total - remaining)
    windows.M = {
      usedPercent: clampUsedPercent(total > 0 ? (used / total) * 100 : 0),
      resetsAt: resetToEpochMs(periodEnd),
    }
  }
  return windows
}

/**
 * The Command Code subscription's own usage, normalized to the shared
 * ProviderQuota shape and shared across gateways through the quota cache. As
 * with OpenCode, the figure belongs to the credential that is actually serving,
 * so `lastServed` wins over the pool's current selection.
 */
export async function readCommandCodeUsage(
  credentials = commandCodeCredentials,
  base = COMMANDCODE_API_BASE,
) {
  const number = Number.isSafeInteger(credentials.lastServed) && credentials.lastServed > 0
    ? credentials.lastServed
    : credentials.number
  const key = typeof credentials.keyFor === 'function'
    ? credentials.keyFor(number)
    : credentials.key
  if (!key) return { windows: {}, asof: Date.now(), stale: true }
  const payload = await readQuotaThroughCache({
    key: quotaKey('commandcode', number),
    ttlMs: QUOTA_TTL_MS.commandcode,
    read: async () => {
      try {
        const headers = { authorization: `Bearer ${key}`, accept: 'application/json' }
        const [creditsResponse, subscriptionResponse] = await Promise.all([
          fetch(`${base}/alpha/billing/credits`, { headers, signal: AbortSignal.timeout(5_000) }),
          fetch(`${base}/alpha/billing/subscriptions`, { headers, signal: AbortSignal.timeout(5_000) }),
        ])
        if (!creditsResponse.ok) return { windows: null }
        const credits = await creditsResponse.json()
        const subscription = subscriptionResponse.ok ? await subscriptionResponse.json() : null
        const planId = subscription?.data?.planId
        const periodEnd = subscription?.data?.currentPeriodEnd ?? null
        return {
          windows: commandCodeUsageWindows(credits, planId, periodEnd),
          account: number,
        }
      } catch {
        return { windows: null }
      }
    },
  })
  if (!payload) return { windows: {}, asof: Date.now(), stale: true }
  return payload
}

// ---------------------------------------------------------------------------
// Mistral usage.
//
// Mistral's billing endpoint answers both buckets the Vibe plan spends: the
// plan budget (`vibe_budget`) and the Studio API budget (`api_budget`). Each is
// account-level, so either credential type can read both; the route passes the
// credential that is actually serving so the cache entry follows the account.
// ---------------------------------------------------------------------------
const MISTRAL_BILLING_ENDPOINT =
  process.env.MODEL_GATEWAY_MISTRAL_BILLING_URL ||
  'https://api.mistral.ai/v1/billing/budget'

/**
 * The two budgets as `{ V, A }` windows of used percent. Mistral reports
 * `usage_percentage` already on the 0-100 scale, so it is taken as-is.
 */
export function mistralUsageWindows(payload) {
  const windows = {}
  for (const [field, kind] of [['vibe_budget', 'V'], ['api_budget', 'A']]) {
    const budget = payload?.[field]
    const used = clampUsedPercent(Number(budget?.usage_percentage))
    if (used === null) continue
    windows[kind] = { usedPercent: used, resetsAt: resetToEpochMs(budget?.reset_at) }
  }
  return windows
}

/** The Vibe and Studio budgets for the credential that is serving. */
export async function readMistralUsage(
  credentials = mistralRouteCredentials(),
  endpoint = MISTRAL_BILLING_ENDPOINT,
) {
  const number = Number.isSafeInteger(credentials.lastServed) && credentials.lastServed > 0
    ? credentials.lastServed
    : credentials.number
  const key = credentials.key
  if (!key) return { windows: {}, asof: Date.now(), stale: true }
  const payload = await readQuotaThroughCache({
    key: quotaKey('mistral', number),
    ttlMs: QUOTA_TTL_MS.mistral,
    read: async () => {
      try {
        const response = await fetch(endpoint, {
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
          signal: AbortSignal.timeout(5_000),
        })
        if (!response.ok) return { windows: null }
        return { windows: mistralUsageWindows(await response.json()), account: number }
      } catch {
        return { windows: null }
      }
    },
  })
  if (!payload) return { windows: {}, asof: Date.now(), stale: true }
  return payload
}

/**
 * The subscription's own usage window, read on demand. The footer needs it in
 * the same slot as the Codex figure, and a gateway session is barred from
 * reading Claude.ai state itself (the client's auth module refuses by design)
 * while the credential it describes belongs to the gateway process, so the
 * gateway is the one that reads it.
 *
 * Read from the usage endpoint rather than from the reply headers below: a
 * header only describes the turn that just finished, so a session that has not
 * answered yet - or that only just started - shows nothing at all, which is too
 * late to be worth the space. This endpoint answers immediately and spends no
 * tokens, so the figure is current at the moment the footer asks for it.
 *
 * Probe-verified 2026-09-30: 200 with the subscription's own token, under both
 * a `claude-code` and the passthrough's `claude-cli` user-agent, so the pinned
 * agent is reused rather than a second version guessed at.
 */
const ANTHROPIC_USAGE_ENDPOINT =
  process.env.MODEL_GATEWAY_ANTHROPIC_USAGE_URL ||
  'https://api.anthropic.com/api/oauth/usage'

// Every gateway on the machine asks about the same subscription. Sharing the
// answer through the quota cache, and letting one failure back them all off, is
// what stops N sessions from being N pollers against one account - which is
// exactly how the endpoint started answering 429 and leaving the footer stale.
const ANTHROPIC_QUOTA_KEY = quotaKey('anthropic', 1)
// Backoff starts at a minute and doubles to a quarter hour. A rejected grant is
// not a bad moment - the sign-in is finished and hammering cannot fix it - so
// it gets the long wait outright.
const ANTHROPIC_BACKOFF_BASE_MS = 60_000
const ANTHROPIC_BACKOFF_MAX_MS = 15 * 60_000
const ANTHROPIC_SIGNIN_BACKOFF_MS = 10 * 60_000

/** A used percentage clamped to 0-100, or null when it is not a number. */
function clampUsedPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

/**
 * A reset instant as epoch milliseconds, from either an ISO timestamp the
 * endpoint sends or a reply header's epoch SECONDS. Null when there is nothing
 * usable, so a figure with no reset is reported rather than a fabricated one.
 */
function resetToEpochMs(value) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds since the epoch are ~1.7e9, milliseconds ~1.7e12; anything below
    // the 2001 millisecond boundary is a seconds value.
    return Math.round(value < 1e12 ? value * 1000 : value)
  }
  return null
}

/**
 * The endpoint's own windows as `{ H?, W? }` of `{ usedPercent, resetsAt }`.
 * `utilization` is a percentage 0-100 here - the same scale the client's own
 * Usage screen prints - NOT the 0-1 fraction the reply headers carry, so it is
 * taken as-is. `five_hour` is the session window, `seven_day` the weekly one.
 */
function anthropicUsageWindows(payload) {
  const windows = {}
  for (const [key, kind] of [['five_hour', 'H'], ['seven_day', 'W']]) {
    const used = clampUsedPercent(payload?.[key]?.utilization)
    if (used === null) continue
    windows[kind] = { usedPercent: used, resetsAt: resetToEpochMs(payload?.[key]?.resets_at) }
  }
  return windows
}

function nextAnthropicBackoff(previousMs) {
  if (!Number.isFinite(previousMs) || previousMs <= 0) return ANTHROPIC_BACKOFF_BASE_MS
  return Math.min(previousMs * 2, ANTHROPIC_BACKOFF_MAX_MS)
}

/**
 * A `Retry-After` as milliseconds, uncapped: unlike the upstream retry loop,
 * this value is a wait the provider asked for, not a retry delay the gateway
 * chooses, so a `Retry-After: 120` really does hold the read for two minutes.
 */
function quotaRetryAfterMs(value) {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return Math.max(0, timestamp - Date.now())
}

/**
 * One upstream read for `readQuotaThroughCache`. Returns `{ windows }` on a
 * usable answer, or `{ windows: null, backoffMs }` when it could not answer so
 * the caller records how long to wait before trying again.
 */
async function readAnthropicUpstream() {
  // A key is not a subscription: there is no window to report, and the endpoint
  // would only answer 401. An empty window set is a real answer, not a failure.
  if (process.env.ANTHROPIC_API_KEY) return { windows: {} }
  const previous = await readSharedQuota(ANTHROPIC_QUOTA_KEY)
  const priorBackoff = Number.isFinite(previous?.backoffMs) ? previous.backoffMs : 0
  try {
    const token = await anthropicAccessToken()
    const response = await fetch(ANTHROPIC_USAGE_ENDPOINT, {
      headers: {
        'content-type': 'application/json',
        'user-agent': ANTHROPIC_USER_AGENT,
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) {
      process.stderr.write(
        `model-gateway warning: could not read the Anthropic subscription usage: HTTP ${response.status}\n`,
      )
      return {
        windows: null,
        backoffMs: response.status === 401
          ? ANTHROPIC_SIGNIN_BACKOFF_MS
          : (quotaRetryAfterMs(response.headers.get('retry-after')) ?? nextAnthropicBackoff(priorBackoff)),
      }
    }
    return { windows: anthropicUsageWindows(await response.json()) }
  } catch (error) {
    const message = errorMessage(error)
    process.stderr.write(
      `model-gateway warning: could not read the Anthropic subscription usage: ${message}\n`,
    )
    return {
      windows: null,
      backoffMs: message.toLowerCase().includes('sign-in is no longer valid')
        ? ANTHROPIC_SIGNIN_BACKOFF_MS
        : nextAnthropicBackoff(priorBackoff),
    }
  }
}

/**
 * What Anthropic last reported about the subscription's own limit, taken from
 * the unified rate-limit headers on every real reply. Kept as the fallback for
 * the live read above: when the usage endpoint cannot be reached, the figure
 * the last real reply carried is still a figure, and reporting nothing would
 * read as "no limit" rather than "not known right now".
 *
 * The reply header carries utilization as a FRACTION 0-1 - unlike the endpoint
 * above, which answers 0-100 - and its reset as epoch SECONDS, so both are
 * rescaled here before the two sources can be compared.
 */
let anthropicSubscriptionWindows = null

function recordAnthropicSubscriptionWindows(upstream) {
  const windows = {}
  // The header names carry `5h`/`7d`; the window key is the normalized `H`/`W`.
  for (const [kind, abbrev] of [['H', '5h'], ['W', '7d']]) {
    const utilization = upstream.headers.get(
      `anthropic-ratelimit-unified-${abbrev}-utilization`,
    )
    if (utilization === null) continue
    const used = clampUsedPercent(Number(utilization) * 100)
    if (used === null) continue
    const reset = upstream.headers.get(`anthropic-ratelimit-unified-${abbrev}-reset`)
    windows[kind] = {
      usedPercent: used,
      resetsAt: resetToEpochMs(reset === null ? null : Number(reset)),
    }
  }
  // An API-key session answers without these headers, and a failed reply may
  // too; a reading nobody sent is not a reading, so the last real one stands.
  if (Object.keys(windows).length > 0) {
    anthropicSubscriptionWindows = { windows, asof: Date.now() }
  }
}

/**
 * The figure the footer reads: the newest of the live subscription read (shared
 * across gateways through the quota cache) and the header snapshot from the
 * last real reply. A window set with no figures is not a candidate - a reading
 * beats no reading, however old - and `stale` is true whenever the header path,
 * a backed-off cache read, or an expired live read is what answered.
 */
export async function readAnthropicQuota() {
  const live = await readQuotaThroughCache({
    key: ANTHROPIC_QUOTA_KEY,
    ttlMs: QUOTA_TTL_MS.anthropic,
    read: readAnthropicUpstream,
  })
  const header = anthropicSubscriptionWindows
  const candidates = []
  if (live && live.windows && Object.keys(live.windows).length > 0) candidates.push(live)
  if (header && Object.keys(header.windows).length > 0) {
    candidates.push({ windows: header.windows, asof: header.asof, stale: true })
  }
  if (candidates.length === 0) {
    return { windows: {}, asof: live?.asof ?? header?.asof ?? Date.now(), stale: true }
  }
  candidates.sort((a, b) => b.asof - a.asof)
  const newest = candidates[0]
  const expired = Date.now() - newest.asof > QUOTA_TTL_MS.anthropic
  return {
    windows: newest.windows,
    asof: newest.asof,
    stale: newest.stale === true || expired,
  }
}

function normalizeAnthropicContent(content, nested = false) {
  if (typeof content === 'string') {
    return content === '' && !nested ? [{ type: 'text', text: 'Empty message.' }] : content
  }
  if (!Array.isArray(content)) return content
  const blocks = content
    .filter(block => !(block?.type === 'text' && block.text === '') &&
      !(block?.type === 'thinking' &&
        (typeof block.signature !== 'string' || block.signature === '')))
    .map(block => block?.type === 'tool_result'
      ? { ...block, content: normalizeAnthropicContent(block.content, true) }
      : block)
  return blocks.length === 0 && !nested
    ? [{ type: 'text', text: 'Empty message.' }]
    : blocks
}

async function handleAnthropicPassthrough(req, res, requestUrl, rawBody, modelName, providerName) {
  const provider = ANTHROPIC_PASSTHROUGH_PROVIDERS[providerName]
  const label = provider.label
  const querySource = gatewayQuerySource(req)
  let body
  try {
    body = JSON.parse(rawBody.toString('utf8'))
  } catch (error) {
    anthropicError(res, 400, error instanceof Error ? error.message : 'Invalid JSON')
    return
  }
  try {
    const system = appendRuntimeToolContract(body.system, querySource)
    body = normalizeGatewayEffort({
      ...body,
      // The subscription endpoint identifies the caller from the leading system
      // block, and refuses an unrecognised one with a headerless 429 rather than
      // serving the turn. Only the first-party provider gates on it, so only
      // that provider gets the identity block in front - DeepSeek and Radeon
      // speak the same protocol without caring who is asking.
      system: providerName === 'anthropic'
        ? ensureAgentIdentityPrefix(system)
        : system,
      messages: Array.isArray(body.messages)
        ? body.messages.map(message => ({
            ...message,
            content: normalizeAnthropicContent(message.role === 'assistant'
              ? sanitizeStaleToolCapabilityContent(message.content)
              : sanitizeLegacyCompactionContent(message.content)),
          }))
        : body.messages,
    }, MODELS[modelName], querySource)
  } catch (error) {
    anthropicError(res, 400, error instanceof Error ? error.message : 'Unsupported request')
    return
  }
  rawBody = Buffer.from(JSON.stringify(body))
  const wantsStream = body.stream === true
  const trace = createGatewayTrace({ model: modelName, backend: provider.backend, protocol: 'anthropic-messages' })
  const control = createRequestControl(req, res, trace)
  // A provider that declares a pool rotates across its credentials; one that
  // does not (AMD) keeps the single-key behaviour.
  const sessionId = upstreamSessionId(req, body)
  const pool = provider.pool ? await provider.pool(sessionId) : null
  let credentials
  try {
    credentials = await provider.headers(req, { stream: wantsStream, body, pool })
  } catch (error) {
    const status = error instanceof PassthroughCredentialError ? error.status : 502
    anthropicError(res, status, errorMessage(error))
    trace.finish('auth-error', error, status)
    control.cleanup()
    return
  }
  const { headers, secret } = credentials

  const upstreamUrl = new URL(provider.endpoint)
  upstreamUrl.search = requestUrl.search

  let upstream
  logRequestShape({
    body,
    providerRequest: body,
    model: modelName,
    backend: provider.backend,
    protocol: 'anthropic-messages',
    querySource,
  })
  control.startUpstream()
  try {
    upstream = await fetchWithRetry({
      provider: label,
      url: upstreamUrl,
      // Rebuilt per attempt: a credential failure advances the Claude account
      // pool, and each account carries its own OAuth token.
      options: async () => {
        if (!pool) return { method: 'POST', headers, body: rawBody, signal: control.signal }
        const fresh = await provider.headers(req, { stream: wantsStream, body, pool })
        return { method: 'POST', headers: fresh.headers, body: rawBody, signal: control.signal }
      },
      control,
      trace,
      credentials: pool ?? undefined,
    })
  } catch (error) {
    trace.markError(error)
    const status = control.statusFor(error)
    anthropicError(res, status, status === 504 ? `${label} upstream request timed out` : `${label} connection failed`)
    trace.finish('upstream-error', error, status)
    control.cleanup()
    return
  }

  if (providerName === 'anthropic') recordAnthropicSubscriptionWindows(upstream)

  if (!upstream.ok) {
    const status = upstream.status >= 500 ? 502 : upstream.status
    let detail
    try {
      detail = await safeUpstreamResponseError(
        upstream,
        label,
        secret,
        {
          signal: control.signal,
          timeoutMs: RETRY_RESPONSE_TIMEOUT_MS,
          onTimeout: error => control.abortUpstream(error),
        },
      )
    } catch (error) {
      const boundedStatus = control.signal.aborted ? control.statusFor(error) : status
      anthropicError(
        res,
        boundedStatus,
        boundedStatus === 504
          ? `${label} upstream request timed out`
          : `${label} provider error`,
      )
      trace.finish('upstream-http-error', error, boundedStatus)
      control.cleanup()
      return
    }
    await upstream.body?.cancel().catch(() => {})
    anthropicError(res, status, detail)
    trace.finish('upstream-http-error', null, status)
    control.cleanup()
    return
  }

  try {
    if (wantsStream) {
      await relayDeepSeekStream(res, upstream, trace, {
        signal: control.signal,
      })
    } else {
      await relayDeepSeekResponse(res, upstream, trace)
    }
    trace.markCompletion()
    trace.finish('success', null, res.statusCode)
  } catch (error) {
    trace.markError(error)
    if (!res.headersSent) {
      anthropicError(res, 502, error instanceof Error ? error.message : `${label} stream failed`)
    } else {
      finishAnthropicStreamWithError(res, error)
    }
    trace.finish('stream-error', error, res.statusCode)
  } finally {
    control.cleanup()
  }
}

async function handleDeepSeek(req, res, requestUrl, rawBody, modelName) {
  await handleAnthropicPassthrough(req, res, requestUrl, rawBody, modelName, 'deepseek')
}

function safeLogValue(value) {
  return String(value ?? 'unknown').replace(/[\r\n]/g, ' ')
}

function byteLength(value) {
  if (value == null) return 0
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    return Buffer.byteLength(serialized == null ? '' : serialized, 'utf8')
  } catch {
    return 0
  }
}

export function gatewayRequestShape(body, providerRequest) {
  const system = body?.system
  const messages = body?.messages
  const tools = Array.isArray(body?.tools) ? body.tools : []
  const input = Array.isArray(providerRequest?.input)
    ? providerRequest.input
    : []
  const providerTools = Array.isArray(providerRequest?.tools)
    ? providerRequest.tools
    : []
  const prefix = providerPrefixMaterial(providerRequest)
  const lastInput = input.at(-1)
  const promptCacheKey = providerRequest?.prompt_cache_key
  return {
    anthropic_bytes: byteLength(body),
    system_bytes: byteLength(system),
    message_bytes: byteLength(messages),
    tool_schema_bytes: byteLength(tools),
    system_block_count: Array.isArray(system) ? system.length : (system ? 1 : 0),
    message_count: Array.isArray(messages) ? messages.length : 0,
    tool_count: tools.length,
    provider_input_items: input.length,
    provider_input_bytes: byteLength(input),
    provider_instructions_bytes: byteLength(providerRequest?.instructions),
    provider_tool_count: providerTools.length,
    provider_tool_schema_bytes: byteLength(providerTools),
    provider_request_bytes: byteLength(providerRequest),
    provider_last_input_bytes: byteLength(lastInput),
    provider_prefix_bytes: Buffer.byteLength(prefix, 'utf8'),
    provider_prefix_fingerprint: fingerprint(prefix),
    prompt_cache_key_present:
      typeof promptCacheKey === 'string' ? 1 : 0,
    prompt_cache_key_fingerprint:
      typeof promptCacheKey === 'string' ? fingerprint(promptCacheKey) : 'none',
  }
}

function logRequestShape({
  body,
  providerRequest,
  model,
  backend,
  protocol,
  querySource,
  variant = 0,
}) {
  if (!LOG_REQUEST_SHAPE) return
  const shape = gatewayRequestShape(body, providerRequest)
  const prefixState = cachePrefixState(
    body,
    model,
    querySource,
    shape.provider_prefix_fingerprint,
  )
  const fields = [
    `model=${safeLogValue(model)}`,
    `backend=${safeLogValue(backend)}`,
    `protocol=${safeLogValue(protocol || 'none')}`,
    `query_source=${safeLogValue(querySource || 'normal')}`,
    `variant=${Number.isInteger(variant) ? variant : 0}`,
    `stream=${body?.stream === true ? 'sse' : 'json'}`,
    `effort=${safeLogValue(body?.output_config?.effort || body?.reasoning?.effort || 'disabled')}`,
    `cache_prefix_state=${prefixState}`,
    `cache_key_mode=${safeLogValue(CODEX_PROMPT_CACHE_KEY_MODE)}`,
    ...Object.entries(shape).map(([key, value]) => `${key}=${safeLogValue(value)}`),
  ]
  process.stderr.write(`model-gateway shape ${fields.join(' ')}\n`)
}

function logRoute(requestUrl, modelName, backend, body = null) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  const mcpToolCount = tools.filter(tool =>
    typeof tool?.name === 'string' && tool.name.startsWith('mcp__'),
  ).length
  process.stderr.write(
    `model-gateway route path=${requestUrl.pathname} model=${safeLogValue(modelName)} backend=${backend}` +
    ` stream=${body?.stream === true ? 'sse' : 'json'}` +
    ` tool_count=${tools.length} mcp_tool_count=${mcpToolCount}\n`,
  )
}

export function modelsResponse() {
  const data = DISCOVERABLE_MODEL_NAMES.map(id => {
    const backend = MODELS[id].backend
    const upstream = MODELS[id].upstream || id
    return {
      id,
      object: 'model',
      type: 'model',
      created: 0,
      owned_by:
        backend === 'codex'
          ? 'codex'
          : backend === 'deepseek'
            ? 'deepseek'
            : backend === 'amd-radeon'
              ? 'amd-radeon'
              : backend === 'anthropic'
                ? 'anthropic'
                : backend === 'commandcode'
                  ? 'commandcode'
                  : backend === 'mistral'
                    ? 'mistral'
                    : backend === 'opencode-zen'
                    ? 'opencode-zen'
                    : 'opencode-go',
      display_name: upstream,          // Claude Code's gateway discovery labels entries by this
      effort_levels: Array.isArray(MODELS[id].effortLevels)
        ? [...MODELS[id].effortLevels]
        : [],
      ...(MODELS[id].supportsTools === false ? { supports_tools: false } : {}),
    }
  })
  return {
    object: 'list',
    data,
    models: DISCOVERABLE_MODEL_NAMES,
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${HOST}`)

  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    process.stderr.write('model-gateway route path=/health backend=health\n')
    json(res, 200, { status: 'ok', modelCount: MODEL_NAMES.length })
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/v1/models') {
    process.stderr.write('model-gateway route path=/v1/models backend=models\n')
    json(res, 200, modelsResponse())
    return
  }

  if (req.method === 'POST' && requestUrl.pathname === '/gateway/opencode-account') {
    let selection
    try { selection = JSON.parse((await readRawBody(req)).toString('utf8')) } catch {
      json(res, 400, { error: 'Invalid account selection' })
      return
    }
    const { number, sessionId, scope } = selection ?? {}
    if (!Number.isSafeInteger(number) || number < 1 || !['session', 'global'].includes(scope) || typeof sessionId !== 'string' || !sessionId.trim()) {
      json(res, 400, { error: 'Use a positive account number and session or global scope' })
      return
    }
    const pool = await sessionOpenCodeCredentials(sessionId)
    if (!pool.numbers.includes(number)) {
      json(res, 400, { error: `Account ${number} is not loaded. Available: ${pool.numbers.join(', ')}. Run /refreshlogin after adding a key.` })
      return
    }
    if (scope === 'global') {
      const temp = `${openCodePreferencePath}.${randomUUID()}.tmp`
      try {
        await fs.mkdir(path.dirname(openCodePreferencePath), { recursive: true })
        await fs.writeFile(temp, JSON.stringify({ number }))
        await fs.rename(temp, openCodePreferencePath)
      } catch {
        await fs.unlink(temp).catch(() => {})
        json(res, 500, { error: 'Could not save the global OpenCode account' })
        return
      }
      await sessionOpenCodeCredentials(sessionId)
      openCodeCredentials.select(number)
      for (const entry of openCodeSessionCredentials.values()) {
        if (!entry.explicit) entry.pool.select(number)
      }
      openCodeSessionCredentials.get(sessionId).explicit = false
    } else {
      openCodeSessionCredentials.get(sessionId).explicit = true
    }
    pool.select(number)
    json(res, 200, { number, scope })
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/gateway/opencode-account') {
    const pool = await sessionOpenCodeCredentials(requestUrl.searchParams.get('sessionId'))
    json(res, 200, { number: pool.number, global: openCodeGlobalNumber, available: pool.numbers })
    return
  }

  if (req.method === 'POST' && requestUrl.pathname === '/gateway/commandcode-account') {
    let selection
    try { selection = JSON.parse((await readRawBody(req)).toString('utf8')) } catch {
      json(res, 400, { error: 'Invalid account selection' })
      return
    }
    const { number, sessionId, scope } = selection ?? {}
    if (!Number.isSafeInteger(number) || number < 1 || !['session', 'global'].includes(scope) || typeof sessionId !== 'string' || !sessionId.trim()) {
      json(res, 400, { error: 'Use a positive account number and session or global scope' })
      return
    }
    const pool = await sessionCommandCodeCredentials(sessionId)
    if (!pool.numbers.includes(number)) {
      json(res, 400, { error: `Account ${number} is not loaded. Available: ${pool.numbers.join(', ')}. Run /refreshlogin after adding a key.` })
      return
    }
    if (scope === 'global') {
      const temp = `${commandCodePreferencePath}.${randomUUID()}.tmp`
      try {
        await fs.mkdir(path.dirname(commandCodePreferencePath), { recursive: true })
        await fs.writeFile(temp, JSON.stringify({ number }))
        await fs.rename(temp, commandCodePreferencePath)
      } catch {
        await fs.unlink(temp).catch(() => {})
        json(res, 500, { error: 'Could not save the global Command Code account' })
        return
      }
      await sessionCommandCodeCredentials(sessionId)
      commandCodeCredentials.select(number)
      for (const entry of commandCodeSessionCredentials.values()) {
        if (!entry.explicit) entry.pool.select(number)
      }
      commandCodeSessionCredentials.get(sessionId).explicit = false
    } else {
      commandCodeSessionCredentials.get(sessionId).explicit = true
    }
    pool.select(number)
    json(res, 200, { number, scope })
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/gateway/commandcode-account') {
    const pool = await sessionCommandCodeCredentials(requestUrl.searchParams.get('sessionId'))
    json(res, 200, { number: pool.number, global: commandCodeGlobalNumber, available: pool.numbers })
    return
  }

  if (req.method === 'POST' && requestUrl.pathname === '/gateway/mistral-account') {
    let selection
    try { selection = JSON.parse((await readRawBody(req)).toString('utf8')) } catch {
      json(res, 400, { error: 'Invalid account selection' })
      return
    }
    const { number, sessionId, scope } = selection ?? {}
    if (!Number.isSafeInteger(number) || number < 1 || !['session', 'global'].includes(scope) || typeof sessionId !== 'string' || !sessionId.trim()) {
      json(res, 400, { error: 'Use a positive account number and session or global scope' })
      return
    }
    const pool = await sessionMistralCredentials(sessionId)
    if (!pool.numbers.includes(number)) {
      json(res, 400, { error: `Account ${number} is not loaded. Available: ${pool.numbers.join(', ')}. Run /refreshlogin after adding a key.` })
      return
    }
    if (scope === 'global') {
      const temp = `${mistralPreferencePath}.${randomUUID()}.tmp`
      try {
        await fs.mkdir(path.dirname(mistralPreferencePath), { recursive: true })
        await fs.writeFile(temp, JSON.stringify({ number }))
        await fs.rename(temp, mistralPreferencePath)
      } catch {
        await fs.unlink(temp).catch(() => {})
        json(res, 500, { error: 'Could not save the global Mistral account' })
        return
      }
      await sessionMistralCredentials(sessionId)
      mistralCredentials.select(number)
      for (const entry of mistralSessionCredentials.values()) {
        if (!entry.explicit) entry.pool.select(number)
      }
      mistralSessionCredentials.get(sessionId).explicit = false
    } else {
      mistralSessionCredentials.get(sessionId).explicit = true
    }
    pool.select(number)
    json(res, 200, { number, scope })
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/gateway/mistral-account') {
    const pool = await sessionMistralCredentials(requestUrl.searchParams.get('sessionId'))
    const vibeAvailable = mistralVibeCredentials.numbers.filter(number => !mistralVibeFailed.has(number))
    json(res, 200, {
      number: pool.number,
      global: mistralGlobalNumber,
      available: pool.numbers,
      // Vibe plan keys are a separate credential type and are always tried
      // before the Studio pool; `active` is the Vibe number a request would
      // spend now, or null when the plan budget has been marked exhausted.
      vibe: {
        active: vibeAvailable[0] ?? null,
        available: mistralVibeCredentials.numbers,
        failed: [...mistralVibeFailed],
      },
    })
    return
  }

  if (req.method === 'POST' && requestUrl.pathname === '/gateway/codex-account') {
    if (!codexPoolEnabled()) {
      json(res, 400, { error: 'No Codex account is loaded. Run /login codex to sign in.' })
      return
    }
    let selection
    try { selection = JSON.parse((await readRawBody(req)).toString('utf8')) } catch {
      json(res, 400, { error: 'Invalid account selection' })
      return
    }
    const { number, name, sessionId, scope } = selection ?? {}
    if (!['session', 'global'].includes(scope) || typeof sessionId !== 'string' || !sessionId.trim()) {
      json(res, 400, { error: 'Use an account number or name and session or global scope' })
      return
    }
    const accounts = await codexLoadedAccounts()
    if (accounts.length === 0) {
      json(res, 400, { error: 'No Codex account is loaded. Run /login codex to sign in.' })
      return
    }
    const account = Number.isSafeInteger(number) && number > 0
      ? accounts.find(candidate => candidate.number === number)
      : accounts.find(candidate => candidate.name === name)
    if (!account) {
      json(res, 400, {
        error: `Codex account ${name ?? number} is not loaded. Available: ${accounts.map(candidate => `${candidate.number}=${candidate.name}`).join(', ')}.`,
      })
      return
    }
    if (scope === 'global') {
      try {
        await setCurrentCodexAccount(account.name)
      } catch {
        json(res, 500, { error: 'Could not save the global Codex account' })
        return
      }
      codexSessionSelections.delete(sessionId)
      // Unpinned sessions follow the global default immediately; a session that
      // pinned itself keeps its own account.
      for (const [key, entry] of codexPools) {
        if (!codexSessionSelections.has(key)) entry.pool.select(account.number)
      }
    } else {
      codexSessionSelections.set(sessionId, account.number)
      codexPools.get(sessionId)?.pool.select(account.number)
    }
    json(res, 200, { number: account.number, name: account.name, scope })
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/gateway/codex-account') {
    if (!codexPoolEnabled()) {
      json(res, 200, { number: 1, global: 1, available: [], accounts: [] })
      return
    }
    const sessionId = requestUrl.searchParams.get('sessionId')
    const accounts = await codexLoadedAccounts()
    const selectedName = await currentCodexAccountName()
    const global = accounts.find(account => account.name === selectedName)?.number ?? accounts[0]?.number ?? 1
    // The live pool reports the account that would serve now, including a
    // failover the session has already made.
    const number = (await codexRequestPool(sessionId))?.number ?? global
    json(res, 200, {
      number,
      global,
      available: accounts.map(account => account.number),
      accounts: accounts.map(account => ({
        number: account.number,
        name: account.name,
        ...(account.email ? { email: account.email } : {}),
        ...(account.displayName ? { displayName: account.displayName } : {}),
      })),
    })
    return
  }

  if (req.method === 'POST' && requestUrl.pathname === '/gateway/anthropic-account') {
    if (!anthropicPoolEnabled()) {
      json(res, 400, { error: 'No Claude account is stored. Run /login claude to sign in.' })
      return
    }
    let selection
    try { selection = JSON.parse((await readRawBody(req)).toString('utf8')) } catch {
      json(res, 400, { error: 'Invalid account selection' })
      return
    }
    const { number, name, email, sessionId, scope } = selection ?? {}
    if (!['session', 'global'].includes(scope) || typeof sessionId !== 'string' || !sessionId.trim()) {
      json(res, 400, { error: 'Use an account number, name, or email and session or global scope' })
      return
    }
    const accounts = await anthropicLoadedAccounts()
    if (accounts.length === 0) {
      json(res, 400, { error: 'No Claude account is stored. Run /login claude to sign in.' })
      return
    }
    const account = Number.isSafeInteger(number) && number > 0
      ? accounts.find(candidate => candidate.number === number)
      : findAnthropicAccount(accounts, name ?? email)
    if (!account) {
      json(res, 400, {
        error: `Claude account ${name ?? email ?? number} is not stored. Available: ${accounts.map(candidate => `${candidate.number}=${candidate.name}${candidate.email ? ` <${candidate.email}>` : ''}`).join(', ')}.`,
      })
      return
    }
    if (scope === 'global') {
      try {
        await setCurrentAnthropicAccount(account.name)
      } catch {
        json(res, 500, { error: 'Could not save the global Claude account' })
        return
      }
      anthropicSessionSelections.delete(sessionId)
      for (const [key, entry] of anthropicPools) {
        if (!anthropicSessionSelections.has(key)) entry.pool.select(account.number)
      }
    } else {
      anthropicSessionSelections.set(sessionId, account.number)
      anthropicPools.get(sessionId)?.pool.select(account.number)
    }
    json(res, 200, { number: account.number, name: account.name, email: account.email, scope })
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/gateway/anthropic-account') {
    if (!anthropicPoolEnabled()) {
      json(res, 200, { number: 1, global: 1, available: [], accounts: [] })
      return
    }
    const sessionId = requestUrl.searchParams.get('sessionId')
    const accounts = await anthropicLoadedAccounts()
    const selectedName = await currentAnthropicAccountName()
    const global = accounts.find(account => account.name === selectedName)?.number ?? accounts[0]?.number ?? 1
    const number = (await anthropicRequestPool(sessionId))?.number ?? global
    json(res, 200, {
      number,
      global,
      available: accounts.map(account => account.number),
      accounts: accounts.map(account => ({
        number: account.number,
        name: account.name,
        ...(account.email ? { email: account.email } : {}),
        ...(account.displayName ? { displayName: account.displayName } : {}),
      })),
    })
    return
  }

  // Reload the credential set from Keysafe. The gateway cannot re-read the vault
  // itself (it only ever reads env), so it answers the caller, flushes, and exits
  // with a code the supervisor recognizes as a deliberate restart; the supervisor
  // respawns it under a freshly built keysafe chain. Answered before the exit so
  // /refreshlogin gets the account list it is about to load.
  if (req.method === 'POST' && requestUrl.pathname === '/gateway/reload-keys') {
    const sessionId = requestUrl.searchParams.get('sessionId')
    const pool = await sessionOpenCodeCredentials(sessionId)
    const commandCodePool = await sessionCommandCodeCredentials(sessionId)
    const mistralPool = await sessionMistralCredentials(sessionId)
    const codexLoaded = await codexLoadedAccounts()
    const anthropicLoaded = await anthropicLoadedAccounts()
    // `available` stays the OpenCode list: the opencode CLI reads it as its own
    // accounts. CommandCode numbers travel separately and its CLI re-reads GET
    // /gateway/commandcode-account, which already returns its own `available`.
    process.stderr.write('model-gateway route path=/gateway/reload-keys backend=reload-keys\n')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      reloading: true,
      available: pool.numbers,
      commandcodeAvailable: commandCodePool.numbers,
      mistralAvailable: mistralPool.numbers,
      mistralVibeAvailable: mistralVibeCredentials.numbers,
      codexAvailable: codexLoaded.map(account => account.number),
      claudeAvailable: anthropicLoaded.map(account => account.number),
    }), () => {
      setTimeout(() => process.exit(GATEWAY_RELOAD_EXIT_CODE), 25)
    })
    return
  }

  // Heal a running gateway with a key that appeared in the vault after it
  // started. A short-lived keysafe child posts the record here; the value lands
  // in the transient overlay for this process only and is never written to the
  // real environment, logged, or persisted. The ordinary keysafe chain supplies
  // the key on the next spawn.
  if (req.method === 'POST' && requestUrl.pathname === '/gateway/keys') {
    let injection
    try { injection = JSON.parse((await readRawBody(req)).toString('utf8')) } catch {
      json(res, 400, { error: 'Invalid key injection' })
      return
    }
    const { name, value } = injection ?? {}
    if (!isGatewayKeyEnvVar(name) || !isPooledKeyEnvVar(name) || typeof value !== 'string' || value.length === 0) {
      json(res, 400, { error: 'Use a numbered pool key name and a non-empty value' })
      return
    }
    gatewayKeyOverlay[name] = value
    process.stderr.write(`model-gateway route path=/gateway/keys backend=keys name=${safeLogValue(name)}\n`)
    noteGatewayKeyInjected(name)
    json(res, 200, { name, injected: true })
    return
  }

  // What this gateway knows about a credential's ability to serve.
  //
  // The answer is about a NUMBER, not a model: one key serves several model
  // ids, so asking "is this model healthy" would be asking a question the
  // evidence cannot answer. A credential nothing has exercised yet reads
  // `unknown` - the pre-open caller has no recipient to ask, and a non-answer
  // must never be mistaken for a healthy route.
  //
  // Naming neither a number nor a session asks about the POOL (see
  // `fleetRouteHealth`), which is the only question whose answer survives the
  // gateway's own rotation: it fails over past a dead key, so the selected
  // key's verdict does not decide whether the route can serve.
  if (req.method === 'GET' && requestUrl.pathname === '/gateway/route-health') {
    const providerId = routeHealthProviderId(requestUrl.searchParams.get('provider'))
    if (!providerId) {
      json(res, 400, { error: 'Use provider=commandcode|mistral|mistral-vibe|opencode-go|opencode-zen|deepseek|amd-radeon|anthropic|codex' })
      return
    }
    const sessionId = requestUrl.searchParams.get('sessionId')
    const rawNumber = requestUrl.searchParams.get('number')
    // No credential named means the caller is asking about the pool as a
    // whole. That is the question a sender can actually act on, because the
    // gateway rotates past a dead key without the caller doing anything.
    if (rawNumber === null && !sessionId) {
      const numbers = await providerRouteNumbers(providerId, sessionId)
      const fleet = fleetRouteHealth(providerId, numbers)
      process.stderr.write(
        `model-gateway route path=/gateway/route-health backend=route-health-fleet provider=${providerId} fleet=${fleet.fleet} size=${fleet.size}\n`,
      )
      json(res, 200, fleet)
      return
    }
    let number
    if (rawNumber !== null) {
      if (!/^[1-9][0-9]*$/.test(rawNumber)) {
        json(res, 400, { error: 'number must be a positive integer' })
        return
      }
      number = Number(rawNumber)
    } else if (sessionId) {
      number = await sessionRouteNumber(providerId, sessionId)
    } else {
      json(res, 400, { error: 'Use number or sessionId to name a credential, or omit both for the provider fleet' })
      return
    }
    process.stderr.write(
      `model-gateway route path=/gateway/route-health backend=route-health provider=${providerId} number=${number}\n`,
    )
    json(res, 200, routeHealthFor(providerId, number))
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/gateway/opencode-usage') {
    const pool = await sessionOpenCodeCredentials(requestUrl.searchParams.get('sessionId'))
    json(res, 200, await readOpenCodeSubscriptionUsage(pool))
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/gateway/commandcode-usage') {
    process.stderr.write('model-gateway route path=/gateway/commandcode-usage backend=commandcode-usage\n')
    const pool = await sessionCommandCodeCredentials(requestUrl.searchParams.get('sessionId'))
    json(res, 200, await readCommandCodeUsage(pool))
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/gateway/mistral-usage') {
    process.stderr.write('model-gateway route path=/gateway/mistral-usage backend=mistral-usage\n')
    const studio = await sessionMistralCredentials(requestUrl.searchParams.get('sessionId'))
    json(res, 200, await readMistralUsage(mistralRouteCredentials(studio)))
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/gateway/codex-usage') {
    process.stderr.write('model-gateway route path=/gateway/codex-usage backend=codex-usage\n')
    json(res, 200, await readCodexQuota())
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/gateway/anthropic-usage') {
    process.stderr.write('model-gateway route path=/gateway/anthropic-usage backend=anthropic-usage\n')
    json(res, 200, await readAnthropicQuota())
    return
  }

  if (req.method !== 'POST' || requestUrl.pathname !== '/v1/messages') {
    json(res, 404, { error: 'Not found' })
    return
  }

  let rawBody
  try {
    rawBody = await readRawBody(req)
  } catch (error) {
    logRoute(requestUrl, 'unknown', 'invalid-request')
    anthropicError(res, 400, error instanceof Error ? error.message : 'Invalid request body')
    return
  }

  let body
  try {
    body = JSON.parse(rawBody.toString('utf8'))
  } catch (error) {
    logRoute(requestUrl, 'unknown', 'invalid-request')
    anthropicError(res, 400, error instanceof Error ? error.message : 'Invalid JSON')
    return
  }

  const modelName = typeof body?.model === 'string' ? body.model : ''
  const route = MODELS[modelName]
  if (!route) {
    logRoute(requestUrl, modelName || 'unknown', 'unsupported')
    anthropicError(res, 400, `Unsupported model: ${modelName || 'missing'}`)
    return
  }

  const chain = fallbackChainFor(modelName)
  logRoute(requestUrl, modelName, route.backend, body)
  let lastFailure = null
  for (let index = 0; index <= chain.length; index += 1) {
    const hopName = index === 0 ? modelName : chain[index - 1]
    const hopRoute = index === 0 ? route : MODELS[hopName]
    if (!hopRoute) break
    // Only a hop with a successor can be abandoned. The last hop writes to the
    // real response, so a chain that runs out surfaces its own error verbatim.
    const canFallback = index < chain.length
    const hopRawBody = requestBodyForRoute(rawBody, hopName, hopRoute)
    if (index > 0) {
      logRoute(requestUrl, hopName, hopRoute.backend, body)
      res.setHeader('x-gateway-fallback-from', safeLogValue(modelName))
    }
    const attempt = canFallback ? createFallbackAttempt(res) : null
    await dispatchRoute({
      body,
      rawBody: hopRawBody,
      req,
      res: attempt ? attempt.res : res,
      requestUrl,
      modelName: hopName,
      route: hopRoute,
    })
    if (!attempt) return
    if (attempt.state.committed) return
    // Nothing reached the client. A swallowed retryable status is the failure a
    // fallback is for; a handler that simply returned leaves a dead upstream.
    lastFailure = attempt.state.failure ?? { status: 502, message: 'No response from upstream' }
    if (res.destroyed || res.writableEnded) return
    if (!FALLBACK_RETRYABLE(lastFailure.status)) return
    const delay = retryDelayMs(index + 1, null)
    process.stderr.write(
      `model-gateway fallback from=${safeLogValue(hopName)} to=${safeLogValue(chain[index])}` +
      ` status=${safeLogValue(lastFailure.status)} delay_ms=${delay}\n`,
    )
    await waitForRetry(delay, null)
  }
  anthropicError(
    res,
    lastFailure?.status ?? 502,
    lastFailure?.message ?? 'All model fallbacks failed',
  )
})

// The per-backend dispatch, lifted out of the request handler so a fallback hop
// can re-issue the same request against another route. The translating backends
// build their own provider request from `body`; the passthrough backends forward
// `rawBody` verbatim, which is why the caller has already named the provider's
// own model id inside it.
async function dispatchRoute({ body, rawBody, req, res, requestUrl, modelName, route }) {
  if (route.backend === 'codex') {
    await handleCodex(body, req, res, modelName, route)
    return
  }
  if (route.backend === 'opencode-go') {
    await handleOpenCodeGo(body, req, res, modelName, route)
    return
  }
  if (route.backend === 'opencode-zen') {
    await handleOpenCodeZen(body, req, res, modelName, route)
    return
  }
  if (route.backend === 'commandcode') {
    await handleCommandCode(body, req, res, modelName, route)
    return
  }
  if (route.backend === 'mistral') {
    await handleMistral(body, req, res, modelName, route)
    return
  }
  if (route.backend === 'amd-radeon') {
    await handleAnthropicPassthrough(req, res, requestUrl, rawBody, modelName, 'amd-radeon')
    return
  }
  // The Anthropic body is forwarded as-is, so a hidden native alias has to
  // reach the provider under the id it knows.
  if (route.backend === 'anthropic') {
    await handleAnthropicPassthrough(req, res, requestUrl, rawBody, modelName, 'anthropic')
    return
  }
  await handleDeepSeek(req, res, requestUrl, rawBody, modelName)
}

// The passthrough backends forward the Anthropic body as-is, so a route whose
// provider model differs from the Gateway id - a claude-* deepseek alias, a
// hidden native duplicate - has to carry the provider's name in `model`. The
// translating backends ignore body.model entirely and need no rewrite.
function requestBodyForRoute(rawBody, modelName, route) {
  if (
    route.backend !== 'amd-radeon' &&
    route.backend !== 'anthropic' &&
    route.backend !== 'deepseek'
  ) {
    return rawBody
  }
  const upstream = typeof route.upstream === 'string' && route.upstream ? route.upstream : modelName
  if (upstream === modelName) return rawBody
  try {
    const body = JSON.parse(rawBody.toString('utf8'))
    body.model = upstream
    return Buffer.from(JSON.stringify(body))
  } catch {
    // Malformed body: let the handler surface the real error.
    return rawBody
  }
}

server.on('error', error => {
  process.stderr.write(
    `model-gateway error: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})

// The Codex app-server is a child of this process, so stop it on the way out
// rather than leaving it to be reparented.
process.on('exit', () => {
  stopCodexQuota()
})

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  server.listen(PORT, HOST, () => {
    const address = server.address()
    const boundPort = typeof address === 'object' && address ? address.port : PORT
    process.stderr.write(
      `model-gateway listening on http://${HOST}:${boundPort} models=${DISCOVERABLE_MODEL_NAMES.join(',')}\n`,
    )
  })
}
