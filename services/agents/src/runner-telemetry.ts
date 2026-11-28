import type { TokenUsageBreakdown } from '@proompteng/codex'
import { z } from 'zod'

export const runnerTelemetryKey = (namespace: string, uid: string) => `runner-telemetry/${namespace}/${uid}.json`
export const RUNNER_LOG_SUFFIX = '.events.jsonl'

const count = z.number().int().nonnegative()
const timestamp = z.iso.datetime()
const identifier = z.string().max(256)

export const runnerUsageSchema = z.object({
  inputTokens: count,
  cachedInputTokens: count,
  cacheWriteInputTokens: count,
  outputTokens: count,
  reasoningOutputTokens: count,
  totalTokens: count,
}) satisfies z.ZodType<TokenUsageBreakdown>

const quotaWindow = z.object({
  usedPercent: z.number().nonnegative(),
  windowDurationMins: count.nullable(),
  resetsAt: count.nullable(),
})

export const runnerQuotaSchema = z.object({
  limitId: identifier.nullish().transform((value) => value ?? null),
  limitName: identifier.nullish().transform((value) => value ?? null),
  primary: quotaWindow.nullable(),
  secondary: quotaWindow.nullable(),
})

export const runnerTelemetrySchema = z.object({
  version: z.literal(1),
  state: z.enum(['starting', 'running', 'finished']),
  startedAt: timestamp,
  heartbeatAt: timestamp,
  lastActivityAt: timestamp.nullable(),
  podName: identifier.nullable(),
  model: identifier.nullable(),
  effort: z.string().max(32).nullable(),
  threadId: identifier.nullable(),
  turnId: identifier.nullable(),
  activeTools: z
    .array(
      z.object({
        id: identifier,
        kind: z.enum(['commandExecution', 'mcpToolCall', 'fileChange', 'webSearch', 'dynamicToolCall']),
        title: z.string().max(256),
        startedAt: timestamp,
      }),
    )
    .max(8),
  activeToolCount: count,
  usage: runnerUsageSchema.nullable(),
  quota: runnerQuotaSchema.nullable(),
  publishErrors: count,
})

export type RunnerTelemetry = z.infer<typeof runnerTelemetrySchema>

export const parseRunnerTelemetry = (value: unknown): RunnerTelemetry | null => {
  const parsed = runnerTelemetrySchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
