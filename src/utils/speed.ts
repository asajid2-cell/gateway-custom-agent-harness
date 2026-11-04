import { normalizeGatewayModelId } from './model/gatewayModelIds.js'

/**
 * Output throughput, measured where the tokens actually arrive.
 *
 * A single number cannot be right for both a 20-token reply and a 20k-token
 * one: the first is dominated by time-to-first-token, the second by sampling.
 * So a sample keeps both clocks - the time to the first token and the time
 * spent generating after it - and reports tok/s over the generation window.
 * That is the figure a person means by "how fast is this model", and it is the
 * same definition the perfetto trace already uses for OTPS.
 *
 * The sample is process-local and current-only; durable history lives in the
 * token ledger (one row per response, with the same two clocks), so `/usage`
 * can answer "how fast has this model been" without this module ever growing a
 * store of its own.
 */
export interface SpeedSample {
  /** Exactly the model id the request used. */
  model: string
  outputTokens: number
  /** Request start to last token, including prompt processing. */
  totalMs: number
  /** First token to last token - the span the rate is computed over. */
  generationMs: number
  /** Request start to first token. Zero when the provider streamed no events. */
  ttftMs: number
  tokPerSec: number
  /** Epoch ms when the sample was taken. */
  at: number
}

export interface SpeedSampleInput {
  model: string
  outputTokens: number
  /** Epoch ms when the request was sent. */
  startedAt: number
  /** Epoch ms when the first streamed token arrived, or null for a non-stream reply. */
  firstTokenAt?: number | null
  /** Epoch ms when the last token arrived; defaults to now. */
  endedAt?: number
}

const samples = new Map<string, SpeedSample>()
/**
 * Process-lifetime weighted aggregates. Kept here so the status line can offer
 * a stable session figure next to the last response: a three-token reply can
 * legitimately measure 1000 tok/s, and one such sample should not be mistaken
 * for the model's sustained rate.
 */
const aggregates = new Map<string, { output: number; generationMs: number }>()
const listeners = new Set<() => void>()
let revision = 0

/**
 * The rate, rounded to two decimals, or null when there is no honest answer.
 * Zero tokens and a zero-length window both mean "no measurement", not
 * "infinitely fast" and not "zero speed".
 */
export function outputTokensPerSecond(
  outputTokens: number,
  milliseconds: number,
): number | null {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null
  const rate = outputTokens / (milliseconds / 1000)
  if (!Number.isFinite(rate) || rate <= 0) return null
  return Math.round(rate * 100) / 100
}

/**
 * The key a model is stored under. Gateway aliases fold to their canonical id
 * (so `/model` spelling changes do not split one route's history); the `[1m]`
 * opt-in suffix is not part of the route and is stripped for the same reason.
 */
export function speedKey(model: string): string {
  const trimmed = model.trim()
  if (!trimmed) return ''
  const canonical = normalizeGatewayModelId(trimmed).toLowerCase()
  return canonical.endsWith('[1m]')
    ? canonical.slice(0, -'[1m]'.length)
    : canonical
}

/**
 * Record one response's throughput and wake every reader. Returns the sample,
 * or null when the response carried no measurable output.
 */
export function recordSpeedSample(input: SpeedSampleInput): SpeedSample | null {
  const endedAt = input.endedAt ?? Date.now()
  const totalMs = Math.max(0, endedAt - input.startedAt)
  const firstTokenAt =
    input.firstTokenAt !== null && input.firstTokenAt !== undefined
      ? input.firstTokenAt
      : null
  const generationMs =
    firstTokenAt === null ? totalMs : Math.max(0, endedAt - firstTokenAt)
  const tokPerSec = outputTokensPerSecond(input.outputTokens, generationMs)
  if (tokPerSec === null) return null

  const sample: SpeedSample = {
    model: input.model,
    outputTokens: input.outputTokens,
    totalMs,
    generationMs,
    ttftMs: firstTokenAt === null ? 0 : Math.max(0, firstTokenAt - input.startedAt),
    tokPerSec,
    at: endedAt,
  }
  const key = speedKey(input.model)
  if (!key) return sample
  samples.set(key, sample)
  const aggregate = aggregates.get(key) ?? { output: 0, generationMs: 0 }
  aggregate.output += input.outputTokens
  aggregate.generationMs += generationMs
  aggregates.set(key, aggregate)
  revision += 1
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A render listener must not break the response path.
    }
  }
  return sample
}

/** The most recent sample for a model, or null when this process has none. */
export function getSpeedSample(model: string): SpeedSample | null {
  const key = speedKey(model)
  return key ? samples.get(key) ?? null : null
}

/** Every current sample, for diagnostics and tests. */
export function getSpeedSamples(): SpeedSample[] {
  return [...samples.values()]
}

/**
 * The weighted rate over every measured response in this process, or null when
 * none has been measured. Weighted, not a mean of per-response rates: a short
 * answer and a long one should contribute in proportion to the tokens they
 * actually generated.
 */
export function getAverageSpeed(model: string): number | null {
  const key = speedKey(model)
  const aggregate = key ? aggregates.get(key) : undefined
  if (!aggregate) return null
  return outputTokensPerSecond(aggregate.output, aggregate.generationMs)
}

/**
 * The `speed` object a status-line command receives, or null when this process
 * has no sample for the route. Last-response and session figures are separate
 * keys so a script can show either, and `measured_at` makes a stale value
 * visible rather than implied.
 */
export function speedStatusLineField(model: string): {
  speed: {
    output_tokens_per_second: number
    session_output_tokens_per_second: number | null
    output_tokens: number
    generation_ms: number
    total_ms: number
    ttft_ms: number
    measured_at: string
  }
} | null {
  const sample = getSpeedSample(model)
  if (!sample) return null
  return {
    speed: {
      output_tokens_per_second: sample.tokPerSec,
      session_output_tokens_per_second: getAverageSpeed(model),
      output_tokens: sample.outputTokens,
      generation_ms: sample.generationMs,
      total_ms: sample.totalMs,
      ttft_ms: sample.ttftMs,
      measured_at: new Date(sample.at).toISOString(),
    },
  }
}

/**
 * Subscribe to sample updates. The revision is the snapshot value
 * `useSyncExternalStore` needs; the samples themselves mutate in place per key.
 */
export function subscribeSpeed(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSpeedRevision(): number {
  return revision
}

export function formatTokensPerSecond(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  return (Math.round(value * 10) / 10).toFixed(1)
}

export function resetSpeedForTests(): void {
  samples.clear()
  aggregates.clear()
  listeners.clear()
  revision = 0
}
