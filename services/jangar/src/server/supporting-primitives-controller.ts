import { spawn } from 'node:child_process'

import { asRecord, asString, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'

const DEFAULT_NAMESPACES = ['jangar']
const DEFAULT_INTERVAL_SECONDS = 30

const REQUIRED_CRDS = [
  'approvalpolicies.approvals.proompteng.ai',
  'budgets.budgets.proompteng.ai',
  'secretbindings.security.proompteng.ai',
  'signals.signals.proompteng.ai',
  'signaldeliveries.signals.proompteng.ai',
  'schedules.schedules.proompteng.ai',
  'artifacts.artifacts.proompteng.ai',
  'workspaces.workspaces.proompteng.ai',
]

type CrdCheckState = {
  ok: boolean
  missing: string[]
  checkedAt: string
}

type Condition = {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime: string
}

type CronField = {
  any: boolean
  values: Set<number>
}

type CronSpec = {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
  raw: string
}

type CronFieldParseResult = { ok: true; field: CronField } | { ok: false; reason: string; message: string }

type CronParseResult = { ok: true; spec: CronSpec } | { ok: false; reason: string; message: string }

type ScheduleTarget =
  | { kind: 'Agent'; name: string; namespace: string }
  | { kind: 'Orchestration'; name: string; namespace: string }

const SCHEDULE_LABELS = {
  scheduleName: 'jangar.proompteng.ai/schedule-name',
  scheduleUid: 'jangar.proompteng.ai/schedule-uid',
}

let started = false
let intervalRef: NodeJS.Timeout | null = null
let reconciling = false
let crdCheckState: CrdCheckState | null = null

const nowIso = () => new Date().toISOString()

const shouldStart = () => {
  if (process.env.NODE_ENV === 'test') return false
  const flag = (process.env.JANGAR_SUPPORTING_PRIMITIVES_CONTROLLER_ENABLED ?? '1').trim().toLowerCase()
  return flag !== '0' && flag !== 'false'
}

const parseNamespaces = () => {
  const raw = process.env.JANGAR_SUPPORTING_PRIMITIVES_CONTROLLER_NAMESPACES
  if (!raw) return DEFAULT_NAMESPACES
  const list = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  return list.length > 0 ? list : DEFAULT_NAMESPACES
}

const parseIntervalSeconds = () => {
  const raw = process.env.JANGAR_SUPPORTING_PRIMITIVES_CONTROLLER_INTERVAL_SECONDS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return DEFAULT_INTERVAL_SECONDS
}

const runKubectl = (args: string[]) =>
  new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (payload: { stdout: string; stderr: string; code: number | null }) => {
      if (settled) return
      settled = true
      resolve(payload)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error: Error) => {
      finish({
        stdout,
        stderr: stderr || error.message,
        code: 1,
      })
    })
    child.on('close', (code: number | null) => finish({ stdout, stderr, code }))
  })

const resolveNamespaces = async () => {
  const namespaces = parseNamespaces()
  if (!namespaces.includes('*')) {
    return namespaces
  }
  const result = await runKubectl(['get', 'namespace', '-o', 'json'])
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || 'failed to list namespaces')
  }
  const payload = JSON.parse(result.stdout) as Record<string, unknown>
  const items = Array.isArray(payload.items) ? payload.items : []
  const resolved = items
    .map((item) => {
      const metadata = item && typeof item === 'object' ? (item as Record<string, unknown>).metadata : null
      const name = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).name : null
      return typeof name === 'string' ? name : null
    })
    .filter((value): value is string => Boolean(value))
  if (resolved.length === 0) {
    throw new Error('no namespaces returned by kubectl')
  }
  return resolved
}

const resolveCrdCheckNamespace = () => {
  const namespaces = parseNamespaces()
  if (namespaces.includes('*')) return 'default'
  return namespaces[0] ?? 'default'
}

const checkCrds = async (): Promise<CrdCheckState> => {
  const namespace = resolveCrdCheckNamespace()
  const missing: string[] = []
  const forbidden: string[] = []
  for (const name of REQUIRED_CRDS) {
    const resource = name.split('.')[0] ?? name
    const result = await runKubectl(['get', resource, '-n', namespace, '-o', 'json'])
    if (result.code !== 0) {
      const details = (result.stderr || result.stdout || '').toLowerCase()
      if (details.includes('forbidden') || details.includes('unauthorized')) {
        forbidden.push(name)
      } else {
        missing.push(name)
      }
    }
  }
  const state = {
    ok: missing.length === 0 && forbidden.length === 0,
    missing: [...missing, ...forbidden],
    checkedAt: nowIso(),
  }
  crdCheckState = state
  if (!state.ok) {
    if (missing.length > 0) {
      console.error('[jangar] missing required supporting CRDs:', missing.join(', '))
    }
    if (forbidden.length > 0) {
      console.error(
        `[jangar] insufficient RBAC to read supporting CRDs in namespace ${namespace}: ${forbidden.join(', ')}`,
      )
      console.error('[jangar] ensure the Jangar service account can list supporting CRDs in this namespace')
    }
    console.error('[jangar] install the supporting CRDs before starting the controller')
  }
  return state
}

export const getSupportingPrimitivesControllerHealth = () => ({
  enabled: shouldStart(),
  started,
  crdsReady: crdCheckState?.ok ?? null,
  missingCrds: crdCheckState?.missing ?? [],
  lastCheckedAt: crdCheckState?.checkedAt ?? null,
})

const normalizeConditions = (raw: unknown): Condition[] => {
  if (!Array.isArray(raw)) return []
  const output: Condition[] = []
  for (const item of raw) {
    const record = asRecord(item)
    if (!record) continue
    const type = asString(record.type)
    const status = asString(record.status)
    if (!type || !status) continue
    output.push({
      type,
      status: status === 'True' ? 'True' : status === 'False' ? 'False' : 'Unknown',
      reason: asString(record.reason) ?? undefined,
      message: asString(record.message) ?? undefined,
      lastTransitionTime: asString(record.lastTransitionTime) ?? nowIso(),
    })
  }
  return output
}

const upsertCondition = (conditions: Condition[], update: Omit<Condition, 'lastTransitionTime'>): Condition[] => {
  const next = [...conditions]
  const index = next.findIndex((cond) => cond.type === update.type)
  if (index === -1) {
    next.push({ ...update, lastTransitionTime: nowIso() })
    return next
  }
  const existing = next[index]
  if (existing.status !== update.status || existing.reason !== update.reason || existing.message !== update.message) {
    next[index] = { ...existing, ...update, lastTransitionTime: nowIso() }
  }
  return next
}

const setStatus = async (
  kube: ReturnType<typeof createKubernetesClient>,
  resource: Record<string, unknown>,
  status: Record<string, unknown>,
) => {
  const metadata = asRecord(resource.metadata) ?? {}
  const name = asString(metadata.name)
  const namespace = asString(metadata.namespace)
  if (!name || !namespace) return
  const apiVersion = asString(resource.apiVersion)
  const kind = asString(resource.kind)
  if (!apiVersion || !kind) return
  await kube.applyStatus({ apiVersion, kind, metadata: { name, namespace }, status })
}

const parseNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number.parseFloat(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

const parseQuantity = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const match = trimmed.match(/^(-?\d+(?:\.\d+)?)([a-zA-Z]+)?$/)
  if (!match) return null
  const amount = Number.parseFloat(match[1] ?? '')
  if (!Number.isFinite(amount)) return null
  const suffix = match[2] ?? ''
  if (!suffix) return amount
  if (suffix === 'm') return amount / 1000

  const binary = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  } as const
  const decimal = {
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
    P: 1000 ** 5,
    E: 1000 ** 6,
  } as const

  if (suffix in binary) {
    return amount * binary[suffix as keyof typeof binary]
  }
  if (suffix in decimal) {
    return amount * decimal[suffix as keyof typeof decimal]
  }

  return amount
}

const asStringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []

const parseCronField = (field: string, min: number, max: number): CronFieldParseResult => {
  const trimmed = field.trim()
  if (!trimmed) {
    return { ok: false, reason: 'EmptyField', message: 'cron field is empty' }
  }
  if (trimmed === '*') {
    return { ok: true, field: { any: true, values: new Set() } }
  }
  const values = new Set<number>()
  const parts = trimmed.split(',')
  for (const part of parts) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1
    if (!Number.isFinite(step) || step <= 0) {
      return { ok: false, reason: 'InvalidStep', message: `invalid cron step: ${part}` }
    }
    if (rangePart === '*') {
      for (let value = min; value <= max; value += step) {
        values.add(value)
      }
      continue
    }
    const rangeMatch = rangePart.match(/^(\d+)(?:-(\d+))?$/)
    if (!rangeMatch) {
      return { ok: false, reason: 'InvalidRange', message: `invalid cron range: ${part}` }
    }
    const start = Number.parseInt(rangeMatch[1] ?? '', 10)
    const end = Number.parseInt(rangeMatch[2] ?? rangeMatch[1] ?? '', 10)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < min || end > max || start > end) {
      return { ok: false, reason: 'OutOfRange', message: `cron value out of range: ${part}` }
    }
    for (let value = start; value <= end; value += step) {
      values.add(value)
    }
  }
  return { ok: true, field: { any: false, values } }
}

const parseCronExpression = (expression: string): CronParseResult => {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    return { ok: false, reason: 'InvalidExpression', message: 'cron expression must have 5 fields' }
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = parts
  const minuteResult = parseCronField(minuteRaw, 0, 59)
  if (!minuteResult.ok) return minuteResult
  const hourResult = parseCronField(hourRaw, 0, 23)
  if (!hourResult.ok) return hourResult
  const domResult = parseCronField(domRaw, 1, 31)
  if (!domResult.ok) return domResult
  const monthResult = parseCronField(monthRaw, 1, 12)
  if (!monthResult.ok) return monthResult
  const dowResult = parseCronField(dowRaw, 0, 6)
  if (!dowResult.ok) return dowResult

  return {
    ok: true,
    spec: {
      raw: expression,
      minute: minuteResult.field,
      hour: hourResult.field,
      dayOfMonth: domResult.field,
      month: monthResult.field,
      dayOfWeek: dowResult.field,
    },
  }
}

const matchesCronField = (field: CronField, value: number) => field.any || field.values.has(value)

const resolveDateParts = (date: Date, timezone: string) => {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    const parts = formatter.formatToParts(date)
    const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value])) as Record<string, string>
    const weekday = lookup.weekday ?? ''
    const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday)
    return {
      ok: true as const,
      parts: {
        year: Number.parseInt(lookup.year ?? '', 10),
        month: Number.parseInt(lookup.month ?? '', 10),
        day: Number.parseInt(lookup.day ?? '', 10),
        hour: Number.parseInt(lookup.hour ?? '', 10),
        minute: Number.parseInt(lookup.minute ?? '', 10),
        dayOfWeek: weekdayIndex < 0 ? 0 : weekdayIndex,
      },
    }
  } catch (error) {
    return {
      ok: false as const,
      reason: 'InvalidTimezone',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

const matchesCron = (spec: CronSpec, date: Date, timezone: string) => {
  const result = resolveDateParts(date, timezone)
  if (!result.ok) {
    return result
  }
  const { parts } = result
  const minuteOk = matchesCronField(spec.minute, parts.minute)
  const hourOk = matchesCronField(spec.hour, parts.hour)
  const monthOk = matchesCronField(spec.month, parts.month)
  const domMatch = matchesCronField(spec.dayOfMonth, parts.day)
  const dowMatch = matchesCronField(spec.dayOfWeek, parts.dayOfWeek)
  const domAny = spec.dayOfMonth.any
  const dowAny = spec.dayOfWeek.any
  const dayOk = domAny && dowAny ? true : domAny ? dowMatch : dowAny ? domMatch : domMatch || dowMatch

  return { ok: true as const, matches: minuteOk && hourOk && monthOk && dayOk, parts }
}

const formatTickKey = (parts: { year: number; month: number; day: number; hour: number; minute: number }) =>
  `${parts.year}-${parts.month}-${parts.day}-${parts.hour}-${parts.minute}`

const findNextRun = (spec: CronSpec, from: Date, timezone: string) => {
  const searchLimit = 525_600
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  for (let i = 0; i < searchLimit; i += 1) {
    cursor.setMinutes(cursor.getMinutes() + 1)
    const match = matchesCron(spec, cursor, timezone)
    if (match.ok && match.matches) {
      return cursor.toISOString()
    }
  }
  return null
}

const resolveScheduleTarget = (schedule: Record<string, unknown>, namespace: string): ScheduleTarget | null => {
  const spec = asRecord(schedule.spec) ?? {}
  const agentRef = asRecord(spec.agentRef)
  const orchestrationRef = asRecord(spec.orchestrationRef)
  const targetRef = asRecord(spec.targetRef)

  const agentName = asString(agentRef?.name) ?? asString(targetRef?.name)
  const targetKind = asString(targetRef?.kind)
  const targetNamespace = asString(targetRef?.namespace) ?? namespace

  if (targetKind && targetKind.toLowerCase() === 'agent' && agentName) {
    return { kind: 'Agent', name: agentName, namespace: targetNamespace }
  }

  if (agentName && !targetKind) {
    return { kind: 'Agent', name: agentName, namespace }
  }

  const orchestrationName = asString(orchestrationRef?.name) ?? asString(targetRef?.name)
  if (targetKind && targetKind.toLowerCase() === 'orchestration' && orchestrationName) {
    return { kind: 'Orchestration', name: orchestrationName, namespace: targetNamespace }
  }

  if (orchestrationName && !targetKind && orchestrationRef) {
    return { kind: 'Orchestration', name: orchestrationName, namespace }
  }

  return null
}

const buildScheduleLabels = (schedule: Record<string, unknown>) => {
  const metadata = asRecord(schedule.metadata) ?? {}
  const name = asString(metadata.name)
  const uid = asString(metadata.uid)
  return {
    ...(name ? { [SCHEDULE_LABELS.scheduleName]: name } : {}),
    ...(uid ? { [SCHEDULE_LABELS.scheduleUid]: uid } : {}),
  }
}

const buildAgentRunResource = (
  schedule: Record<string, unknown>,
  namespace: string,
  target: ScheduleTarget & { kind: 'Agent' },
  parameters: Record<string, unknown>,
  idempotencyKey: string,
) => {
  const metadata = asRecord(schedule.metadata) ?? {}
  const scheduleName = asString(metadata.name) ?? 'schedule'
  return {
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'AgentRun',
    metadata: {
      generateName: `${scheduleName}-`,
      namespace: target.namespace ?? namespace,
      labels: buildScheduleLabels(schedule),
    },
    spec: {
      agentRef: { name: target.name },
      parameters,
      idempotencyKey,
    },
  }
}

const buildOrchestrationRunResource = (
  schedule: Record<string, unknown>,
  namespace: string,
  target: ScheduleTarget & { kind: 'Orchestration' },
  parameters: Record<string, unknown>,
  idempotencyKey: string,
) => {
  const metadata = asRecord(schedule.metadata) ?? {}
  const scheduleName = asString(metadata.name) ?? 'schedule'
  return {
    apiVersion: 'orchestration.proompteng.ai/v1alpha1',
    kind: 'OrchestrationRun',
    metadata: {
      generateName: `${scheduleName}-`,
      namespace: target.namespace ?? namespace,
      labels: buildScheduleLabels(schedule),
    },
    spec: {
      orchestrationRef: { name: target.name },
      parameters,
      idempotencyKey,
    },
  }
}

const reconcileApprovalPolicy = async (
  kube: ReturnType<typeof createKubernetesClient>,
  policy: Record<string, unknown>,
) => {
  const spec = asRecord(policy.spec) ?? {}
  const status = asRecord(policy.status) ?? {}
  const conditions = normalizeConditions(status.conditions)
  let updated = conditions

  const mode = asString(spec.mode)
  const requiredApprovals = parseNumber(spec.requiredApprovals)
  const invalid =
    !mode ||
    !['automatic', 'manual'].includes(mode) ||
    (requiredApprovals != null && requiredApprovals < 0) ||
    (requiredApprovals != null && !Number.isFinite(requiredApprovals))

  if (invalid) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'InvalidApprovalPolicy',
      message: 'spec.mode must be automatic or manual and requiredApprovals must be >= 0',
    })
  } else {
    updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'ValidSpec' })
  }

  const phase = invalid ? 'Failed' : (asString(status.phase) ?? (mode === 'automatic' ? 'Approved' : 'Pending'))

  await setStatus(kube, policy, {
    ...status,
    observedGeneration: asRecord(policy.metadata)?.generation ?? 0,
    phase,
    lastCheckedAt: nowIso(),
    conditions: updated,
  })
}

const reconcileBudget = async (kube: ReturnType<typeof createKubernetesClient>, budget: Record<string, unknown>) => {
  const spec = asRecord(budget.spec) ?? {}
  const limits = asRecord(spec.limits) ?? {}
  const status = asRecord(budget.status) ?? {}
  const used = asRecord(status.used) ?? {}
  const conditions = normalizeConditions(status.conditions)
  let updated = conditions

  const limitValues = {
    tokens: parseNumber(limits.tokens),
    dollars: parseNumber(limits.dollars),
    cpu: parseQuantity(limits.cpu),
    memory: parseQuantity(limits.memory),
    gpu: parseQuantity(limits.gpu),
  }
  const hasLimit = Object.values(limitValues).some((value) => value != null)

  if (!hasLimit) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingLimits',
      message: 'spec.limits must include at least one resource limit',
    })
  }

  const usage = {
    tokens: parseNumber(used.tokens),
    dollars: parseNumber(used.dollars),
    cpu: parseQuantity(used.cpu),
    memory: parseQuantity(used.memory),
    gpu: parseQuantity(used.gpu),
  }

  const exceeded =
    (limitValues.tokens != null && usage.tokens != null && usage.tokens > limitValues.tokens) ||
    (limitValues.dollars != null && usage.dollars != null && usage.dollars > limitValues.dollars) ||
    (limitValues.cpu != null && usage.cpu != null && usage.cpu > limitValues.cpu) ||
    (limitValues.memory != null && usage.memory != null && usage.memory > limitValues.memory) ||
    (limitValues.gpu != null && usage.gpu != null && usage.gpu > limitValues.gpu)

  if (hasLimit && exceeded) {
    updated = upsertCondition(updated, {
      type: 'BudgetExceeded',
      status: 'True',
      reason: 'UsageExceeded',
      message: 'budget usage exceeds configured limits',
    })
  } else if (hasLimit) {
    updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'WithinLimits' })
  }

  const phase = !hasLimit ? 'Failed' : exceeded ? 'Exceeded' : 'Active'

  await setStatus(kube, budget, {
    ...status,
    observedGeneration: asRecord(budget.metadata)?.generation ?? 0,
    phase,
    lastCheckedAt: nowIso(),
    conditions: updated,
  })
}

const reconcileSecretBinding = async (
  kube: ReturnType<typeof createKubernetesClient>,
  binding: Record<string, unknown>,
) => {
  const spec = asRecord(binding.spec) ?? {}
  const status = asRecord(binding.status) ?? {}
  const conditions = normalizeConditions(status.conditions)
  let updated = conditions
  const subjects = Array.isArray(spec.subjects) ? (spec.subjects as Record<string, unknown>[]) : []
  const allowedSecrets = asStringArray(spec.allowedSecrets)

  if (subjects.length === 0) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingSubjects',
      message: 'spec.subjects must include at least one subject',
    })
  } else if (allowedSecrets.length === 0) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingSecrets',
      message: 'spec.allowedSecrets must include at least one secret',
    })
  } else {
    updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'ValidSpec' })
  }

  const phase = subjects.length === 0 || allowedSecrets.length === 0 ? 'Failed' : 'Ready'

  await setStatus(kube, binding, {
    ...status,
    observedGeneration: asRecord(binding.metadata)?.generation ?? 0,
    phase,
    lastCheckedAt: nowIso(),
    conditions: updated,
  })
}

const reconcileSignal = async (kube: ReturnType<typeof createKubernetesClient>, signal: Record<string, unknown>) => {
  const spec = asRecord(signal.spec) ?? {}
  const status = asRecord(signal.status) ?? {}
  const conditions = normalizeConditions(status.conditions)
  let updated = conditions

  const schema = spec.payloadSchema
  let invalidSchema = false
  if (typeof schema === 'string' && schema.trim().length > 0) {
    try {
      JSON.parse(schema)
    } catch {
      invalidSchema = true
    }
  }

  const retentionSeconds = parseNumber(spec.retentionSeconds)
  const invalidRetention = retentionSeconds != null && retentionSeconds < 0

  if (invalidSchema) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'InvalidPayloadSchema',
      message: 'spec.payloadSchema must be valid JSON',
    })
  } else if (invalidRetention) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'InvalidRetention',
      message: 'spec.retentionSeconds must be >= 0',
    })
  } else {
    updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'ValidSpec' })
  }

  const phase = invalidSchema || invalidRetention ? 'Failed' : 'Ready'

  await setStatus(kube, signal, {
    ...status,
    observedGeneration: asRecord(signal.metadata)?.generation ?? 0,
    phase,
    lastCheckedAt: nowIso(),
    conditions: updated,
  })
}

const reconcileSignalDelivery = async (
  kube: ReturnType<typeof createKubernetesClient>,
  delivery: Record<string, unknown>,
  namespace: string,
) => {
  const spec = asRecord(delivery.spec) ?? {}
  const status = asRecord(delivery.status) ?? {}
  const conditions = normalizeConditions(status.conditions)
  let updated = conditions

  const signalRef = asRecord(spec.signalRef) ?? {}
  const signalName = asString(signalRef.name)
  const signalNamespace = asString(signalRef.namespace) ?? namespace
  const deliveryId = asString(spec.deliveryId)

  if (!signalName && !deliveryId) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingSignal',
      message: 'spec.signalRef.name or spec.deliveryId is required',
    })
  } else if (signalName) {
    const signal = await kube.get(RESOURCE_MAP.Signal, signalName, signalNamespace)
    if (!signal) {
      updated = upsertCondition(updated, {
        type: 'Unreachable',
        status: 'True',
        reason: 'SignalNotFound',
        message: `signal ${signalName} not found`,
      })
    } else {
      updated = upsertCondition(updated, { type: 'Delivered', status: 'True', reason: 'SignalResolved' })
    }
  } else {
    updated = upsertCondition(updated, { type: 'Delivered', status: 'True', reason: 'DeliveryIdAccepted' })
  }

  const phase = updated.some((condition) => condition.type === 'InvalidSpec' && condition.status === 'True')
    ? 'Failed'
    : updated.some((condition) => condition.type === 'Delivered' && condition.status === 'True')
      ? 'Delivered'
      : 'Pending'

  await setStatus(kube, delivery, {
    ...status,
    observedGeneration: asRecord(delivery.metadata)?.generation ?? 0,
    phase,
    deliveredAt: asString(status.deliveredAt) ?? (phase === 'Delivered' ? nowIso() : undefined),
    conditions: updated,
  })
}

const reconcileArtifact = async (
  kube: ReturnType<typeof createKubernetesClient>,
  artifact: Record<string, unknown>,
  namespace: string,
) => {
  const spec = asRecord(artifact.spec) ?? {}
  const status = asRecord(artifact.status) ?? {}
  const conditions = normalizeConditions(status.conditions)
  let updated = conditions

  const storageRef = asRecord(spec.storageRef) ?? {}
  const storageName = asString(storageRef.name)
  const storageNamespace = asString(storageRef.namespace) ?? namespace
  const provider = asString(storageRef.provider) ?? 'artifact'

  if (!storageName) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingStorageRef',
      message: 'spec.storageRef.name is required',
    })
  } else {
    updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'StorageResolved' })
  }

  const metadata = asRecord(artifact.metadata) ?? {}
  const name = asString(metadata.name) ?? 'artifact'
  const uri = storageName ? `${provider}://${storageNamespace}/${storageName}/${name}` : undefined

  const phase = storageName ? 'Ready' : 'Failed'

  await setStatus(kube, artifact, {
    ...status,
    observedGeneration: asRecord(artifact.metadata)?.generation ?? 0,
    phase,
    uri,
    contentType: asString(readNested(spec, ['metadata', 'contentType'])) ?? asString(status.contentType) ?? undefined,
    conditions: updated,
  })
}

const reconcileWorkspace = async (
  kube: ReturnType<typeof createKubernetesClient>,
  workspace: Record<string, unknown>,
) => {
  const spec = asRecord(workspace.spec) ?? {}
  const status = asRecord(workspace.status) ?? {}
  const conditions = normalizeConditions(status.conditions)
  let updated = conditions

  const size = asString(spec.size)
  const accessModes = asStringArray(spec.accessModes)

  if (!size) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingSize',
      message: 'spec.size is required',
    })
  } else if (accessModes.length === 0) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingAccessModes',
      message: 'spec.accessModes is required',
    })
  } else {
    updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'ValidSpec' })
  }

  const metadata = asRecord(workspace.metadata) ?? {}
  const name = asString(metadata.name) ?? 'workspace'
  const volumeName = asString(status.volumeName) ?? `${name}-volume`
  const phase = size && accessModes.length > 0 ? 'Ready' : 'Failed'

  await setStatus(kube, workspace, {
    ...status,
    observedGeneration: asRecord(workspace.metadata)?.generation ?? 0,
    phase,
    volumeName,
    size,
    accessModes,
    conditions: updated,
  })
}

const reconcileSchedule = async (
  kube: ReturnType<typeof createKubernetesClient>,
  schedule: Record<string, unknown>,
  namespace: string,
  now: Date,
) => {
  const spec = asRecord(schedule.spec) ?? {}
  const status = asRecord(schedule.status) ?? {}
  const conditions = normalizeConditions(status.conditions)
  let updated = conditions

  const cron = asString(spec.cron)
  const timezone = asString(spec.timezone) ?? 'UTC'
  const paused = spec.paused === true || spec.suspend === true
  const target = resolveScheduleTarget(schedule, namespace)

  if (!cron) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingCron',
      message: 'spec.cron is required',
    })
  }

  if (!target) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingTarget',
      message: 'spec.targetRef.kind/name or spec.agentRef/spec.orchestrationRef is required',
    })
  }

  let cronSpec: CronSpec | null = null
  if (cron) {
    const parsed = parseCronExpression(cron)
    if (!parsed.ok) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: parsed.reason,
        message: parsed.message,
      })
    } else {
      cronSpec = parsed.spec
    }
  }

  let nextRunAt: string | null = null
  let lastTriggeredAt = asString(status.lastTriggeredAt)
  let lastRunRef = asRecord(status.lastRunRef) ?? null
  let triggered = false
  let triggerError: string | null = null

  if (cronSpec && target && !paused) {
    const match = matchesCron(cronSpec, now, timezone)
    if (!match.ok) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: match.reason,
        message: match.message,
      })
    } else {
      const nowKey = formatTickKey(match.parts)
      const lastTriggeredKey = (() => {
        if (!lastTriggeredAt) return null
        const lastDate = new Date(lastTriggeredAt)
        const lastParts = resolveDateParts(lastDate, timezone)
        if (!lastParts.ok) return null
        return formatTickKey(lastParts.parts)
      })()

      if (match.matches && nowKey !== lastTriggeredKey) {
        const idempotencyKey = `${namespace}:${asString(asRecord(schedule.metadata)?.name) ?? 'schedule'}:${nowKey}`
        const parameters = asRecord(spec.parameters) ?? {}
        try {
          const resource =
            target.kind === 'Agent'
              ? buildAgentRunResource(schedule, namespace, target, parameters, idempotencyKey)
              : buildOrchestrationRunResource(schedule, namespace, target, parameters, idempotencyKey)
          const applied = await kube.apply(resource)
          const appliedMeta = asRecord(applied.metadata) ?? {}
          lastTriggeredAt = now.toISOString()
          const fallbackName = asString(readNested(resource, ['metadata', 'generateName']))
          lastRunRef = {
            kind: asString(applied.kind) ?? resource.kind,
            name: asString(appliedMeta.name) ?? fallbackName ?? null,
            namespace: asString(appliedMeta.namespace) ?? namespace,
          }
          triggered = true
        } catch (error) {
          triggerError = error instanceof Error ? error.message : String(error)
        }
      }
      nextRunAt = findNextRun(cronSpec, now, timezone)
    }
  }

  if (paused) {
    updated = upsertCondition(updated, { type: 'Paused', status: 'True', reason: 'Paused' })
  } else if (triggered) {
    updated = upsertCondition(updated, { type: 'Triggered', status: 'True', reason: 'RunCreated' })
  } else if (triggerError) {
    updated = upsertCondition(updated, {
      type: 'TriggerFailed',
      status: 'True',
      reason: 'CreateRunFailed',
      message: triggerError,
    })
  } else if (cronSpec && target) {
    updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'Scheduled' })
  }

  const invalid = updated.some((condition) => condition.type === 'InvalidSpec' && condition.status === 'True')
  const phase = paused ? 'Paused' : invalid ? 'Failed' : triggered ? 'Triggered' : 'Ready'

  await setStatus(kube, schedule, {
    ...status,
    observedGeneration: asRecord(schedule.metadata)?.generation ?? 0,
    phase,
    lastTriggeredAt: lastTriggeredAt ?? undefined,
    nextRunAt: nextRunAt ?? undefined,
    lastRunRef: lastRunRef ?? undefined,
    conditions: updated,
  })
}

const reconcileNamespace = async (kube: ReturnType<typeof createKubernetesClient>, namespace: string, now: Date) => {
  const loadItems = async (resource: string) => {
    const response = await kube.list(resource, namespace)
    return Array.isArray(response.items) ? (response.items as Record<string, unknown>[]) : []
  }

  const approvals = await loadItems(RESOURCE_MAP.ApprovalPolicy)
  const budgets = await loadItems(RESOURCE_MAP.Budget)
  const bindings = await loadItems(RESOURCE_MAP.SecretBinding)
  const signals = await loadItems(RESOURCE_MAP.Signal)
  const deliveries = await loadItems(RESOURCE_MAP.SignalDelivery)
  const schedules = await loadItems(RESOURCE_MAP.Schedule)
  const artifacts = await loadItems(RESOURCE_MAP.Artifact)
  const workspaces = await loadItems(RESOURCE_MAP.Workspace)

  for (const policy of approvals) {
    try {
      await reconcileApprovalPolicy(kube, policy)
    } catch (error) {
      console.warn('[jangar] failed to reconcile approval policy', error)
    }
  }

  for (const budget of budgets) {
    try {
      await reconcileBudget(kube, budget)
    } catch (error) {
      console.warn('[jangar] failed to reconcile budget', error)
    }
  }

  for (const binding of bindings) {
    try {
      await reconcileSecretBinding(kube, binding)
    } catch (error) {
      console.warn('[jangar] failed to reconcile secret binding', error)
    }
  }

  for (const signal of signals) {
    try {
      await reconcileSignal(kube, signal)
    } catch (error) {
      console.warn('[jangar] failed to reconcile signal', error)
    }
  }

  for (const delivery of deliveries) {
    try {
      await reconcileSignalDelivery(kube, delivery, namespace)
    } catch (error) {
      console.warn('[jangar] failed to reconcile signal delivery', error)
    }
  }

  for (const schedule of schedules) {
    try {
      await reconcileSchedule(kube, schedule, namespace, now)
    } catch (error) {
      console.warn('[jangar] failed to reconcile schedule', error)
    }
  }

  for (const artifact of artifacts) {
    try {
      await reconcileArtifact(kube, artifact, namespace)
    } catch (error) {
      console.warn('[jangar] failed to reconcile artifact', error)
    }
  }

  for (const workspace of workspaces) {
    try {
      await reconcileWorkspace(kube, workspace)
    } catch (error) {
      console.warn('[jangar] failed to reconcile workspace', error)
    }
  }
}

const reconcileOnce = async () => {
  if (reconciling) return
  reconciling = true
  const kube = createKubernetesClient()
  try {
    const namespaces = await resolveNamespaces()
    const now = new Date()
    for (const namespace of namespaces) {
      await reconcileNamespace(kube, namespace, now)
    }
  } catch (error) {
    console.warn('[jangar] supporting primitives controller failed', error)
  } finally {
    reconciling = false
  }
}

export const startSupportingPrimitivesController = async () => {
  if (started || !shouldStart()) return
  const crdsReady = await checkCrds()
  if (!crdsReady.ok) {
    console.error('[jangar] supporting primitives controller will not start without CRDs')
    return
  }
  started = true
  void reconcileOnce()
  const intervalMs = parseIntervalSeconds() * 1000
  intervalRef = setInterval(() => {
    void reconcileOnce()
  }, intervalMs)
}

export const stopSupportingPrimitivesController = () => {
  if (intervalRef) {
    clearInterval(intervalRef)
    intervalRef = null
  }
  started = false
}

export const __test = {
  parseCronExpression,
  matchesCron,
  resolveDateParts,
  reconcileSchedule,
  buildAgentRunResource,
  buildOrchestrationRunResource,
  SCHEDULE_LABELS,
}
