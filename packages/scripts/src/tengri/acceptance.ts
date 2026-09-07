#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

import YAML from 'yaml'

import { githubCreationLeaseStore, ownerFingerprint, type CreationLeaseStore } from './creation-lease'

const SHA40 = /^[0-9a-f]{40}$/i
const DIGEST = /^sha256:[0-9a-f]{64}$/
const AGENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const LEASE_ID = /^[a-f0-9]{16}$/
const PREVIEW_SESSION_ID = /^[a-z0-9]{24}$/
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/
const COOKIE_PART = /^[^=;\s]+=[^;\r\n]+$/
const MAX_JSON_BYTES = 128 * 1024
const MAX_PREVIEW_BODY_BYTES = 2 * 1024 * 1024
const MAX_TERMINAL_OUTPUT_BYTES = 256 * 1024
const DEFAULT_RESPONSE_BODY_TIMEOUT_MS = 120_000
const COMMAND_TIMEOUT_MS = 120_000
const DEFAULT_TIMEOUT_SECONDS = 900
const DEFAULT_POLL_INTERVAL_SECONDS = 2
const TENGRI_IMAGE = 'registry.ide-newton.ts.net/lab/tengri'
const NANOAGENT_IMAGE = 'registry.ide-newton.ts.net/lab/nanoagent'
const PROOMPTENG_IMAGE = 'registry.ide-newton.ts.net/lab/proompteng'
const BFF_PATH = '/api/tengri'
const KARGO_BRANCHES = {
  tengri: 'kargo/tengri',
  proompteng: 'kargo/proompteng',
} as const
const DESKTOP_ORIGIN = 'https://proompteng.ai'

type RecordLike = Record<string, unknown>
export type StageName = keyof typeof KARGO_BRANCHES

export type AcceptanceOptions = {
  baseUrl: string
  origin: string
  stage: StageName
  expectedRevision: string
  runId: string
  authCookie: string
  rejectionAuthCookie: string
  leaseFile: string
  outputPath: string
  timeoutMs: number
  pollIntervalMs: number
  diagnostic: boolean
}

export type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>

export class AcceptanceError extends Error {
  readonly check: string
  readonly status?: number

  constructor(message: string, check = 'unknown', status?: number) {
    super(message)
    this.name = 'AcceptanceError'
    this.check = check
    this.status = status
  }
}

export class HttpFailure extends AcceptanceError {
  readonly code?: string

  constructor(operation: string, status: number, code?: string) {
    super(operation + ' returned HTTP ' + String(status), operation, status)
    this.name = 'HttpFailure'
    this.code = code
  }
}

type AcceptanceCheckStatus = 'not_run' | 'passed' | 'failed' | 'not_configured'

type AcceptanceCheck = {
  status: AcceptanceCheckStatus
  detail?: string
}

type Evidence = {
  schemaVersion: 1
  status: 'running' | 'passed' | 'failed'
  acceptance: 'core_passed' | 'failed' | 'incomplete'
  diagnostic: boolean
  startedAt: string
  finishedAt?: string
  stage: StageName
  expectedEventRevision: string
  failedCheck?: string
  error?: string
  provenance: {
    tengri?: StageProvenance
    proompteng?: StageProvenance
  }
  delivery: {
    tengri?: DeliveryEvidence
    proompteng?: DeliveryEvidence
  }
  checks: Record<string, AcceptanceCheck>
  canary?: CanaryEvidence
  codexAccount: {
    status: 'not_run' | 'authenticated' | 'not_authenticated' | 'unavailable'
    detail?: string
  }
  cleanup?: {
    status: 'not_run' | 'passed' | 'failed' | 'not_attempted'
    detail?: string
  }
}

type StageProvenance = {
  stage: StageName
  branch: string
  branchRevision: string
  sourceRevision: string
  freightName: string
  digests: {
    tengri?: string
    nanoagent?: string
    proompteng?: string
  }
  manifestDigests: {
    tengri?: string
    nanoagent?: string
    proompteng?: string
  }
}

type DeliveryEvidence = {
  application: string
  targetRevision: string
  syncRevision: string
  syncStatus: string
  healthStatus: string
  deployment: string
  namespace: string
  image: string
  readyReplicas: number
  replicas: number
  podImageDigests: string[]
}

type CanaryEvidence = {
  agentId: string
  displayName: string
  microvmUid?: string
  image: string
  pvcUid?: string
  initialPodUid?: string
  resumedPodUid?: string
  file?: {
    path: string
    bytes: number
    revision: string
    contentSha256: string
    conflictStatus: number
  }
  terminal?: {
    creationId: string
    terminalId: string
  }
  preview?: {
    sessionId: string
    origin: string
  }
  podImageDigest?: string
  workloadsBefore?: {
    count: number
    fingerprint: string
  }
  workloadsAfter?: {
    count: number
    fingerprint: string
  }
}

type AgentSummary = {
  id: string
  displayName: string
  createdAt: string
  phase: string
  message: string
}

type Snapshot = {
  authConfigured: boolean
  controlPlaneConfigured: boolean
  authenticated: boolean
  previewGatewayOrigin: string
  userId: string
  agents: AgentSummary[]
}

type ReadFileResult = {
  path: string
  content: string
  revision: string
}

type WriteFileResult = {
  path: string
  size: number
  revision: string
}

type TerminalResult = {
  id: string
  creationId: string
}

type PreviewResult = {
  id: string
  launchUrl: string
  previewOrigin: string
}

type LeaseRecord = {
  version: 3
  tool: 'tengri-real-guest-acceptance'
  agentId: string
  displayName: string
  agentCreatedAt: string
  microvmUid?: string
  leaseId: string
  ownerFingerprint: string
  createdAt: string
  firstRunId: string
  terminalCreationId: string
  filePath?: string
  filePrefix?: string
  fileContentSha256?: string
  terminalId?: string
  previewSessionIds: string[]
}

type RuntimeEvidence = {
  microvmUid: string
  podName: string
  podUid: string
  pvcName: string
  pvcUid: string
  bootstrapSecretName: string
  image: string
  podImageDigest?: string
}

type WorkloadImages = {
  count: number
  fingerprint: string
  values: Map<string, string>
}

type Dependencies = {
  commandRunner?: CommandRunner
  fetchImpl?: typeof fetch
  creationLeaseStore?: CreationLeaseStore
}

function asRecord(value: unknown): RecordLike | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as RecordLike) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function requiredString(value: unknown, label: string, check: string): string {
  const parsed = asString(value)
  if (!parsed || parsed.length === 0) throw new AcceptanceError('Missing ' + label, check)
  return parsed
}

function containsForbiddenControl(value: string): boolean {
  return value.includes('\r') || value.includes('\n') || value.includes(String.fromCharCode(0))
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'unexpected acceptance failure'
  return raw
    .replace(/(?:cookie|token|authorization|secret|password)[^;\s]*/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 320)
}

function parsePositiveNumber(value: string | undefined, fallback: number, name: string, max: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new AcceptanceError(name + ' must be an integer between 1 and ' + String(max), 'configuration')
  }
  return parsed
}

function normalizeOrigin(value: string): { baseUrl: string; origin: string } {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new AcceptanceError('Acceptance base URL is invalid', 'configuration')
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new AcceptanceError('Acceptance base URL must use HTTPS outside localhost', 'configuration')
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new AcceptanceError('Acceptance base URL must be an origin without credentials or a path', 'configuration')
  }
  return { baseUrl: parsed.origin, origin: parsed.origin }
}

function validateCookieHeader(name: string, value: string | undefined): string {
  if (!value || value.length > 16 * 1024 || containsForbiddenControl(value)) {
    throw new AcceptanceError(name + ' is required and must be a valid Cookie header', 'authentication')
  }
  const pairs = value.split(';').map((part) => part.trim())
  if (pairs.length === 0 || pairs.some((part) => !COOKIE_PART.test(part))) {
    throw new AcceptanceError(name + ' is required and must be a valid Cookie header', 'authentication')
  }
  return pairs.join('; ')
}

function stageFromValue(value: string | undefined): StageName {
  if (value === 'tengri' || value === 'proompteng') return value
  if (value === 'kargo/tengri') return 'tengri'
  if (value === 'kargo/proompteng') return 'proompteng'
  throw new AcceptanceError('stage must be tengri or proompteng', 'configuration')
}

function normalizeRunId(value: string): string {
  if (!SAFE_RUN_ID.test(value)) throw new AcceptanceError('run id contains unsupported characters', 'configuration')
  return value
}

export function parseAcceptanceArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): AcceptanceOptions {
  const values: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      throw new AcceptanceError('help requested', 'help')
    }
    if (!arg.startsWith('--')) throw new AcceptanceError('unknown argument ' + arg, 'configuration')
    const separator = arg.indexOf('=')
    const flag = separator >= 0 ? arg.slice(0, separator) : arg
    const inline = separator >= 0 ? arg.slice(separator + 1) : undefined
    const next = inline ?? argv[index + 1]
    if (inline === undefined) index += 1
    if (next === undefined || next.startsWith('--')) {
      throw new AcceptanceError('missing value for ' + flag, 'configuration')
    }
    const key = {
      '--base-url': 'baseUrl',
      '--stage': 'stage',
      '--expected-revision': 'expectedRevision',
      '--run-id': 'runId',
      '--lease-file': 'leaseFile',
      '--output': 'outputPath',
      '--timeout-seconds': 'timeoutSeconds',
      '--poll-interval-seconds': 'pollIntervalSeconds',
    }[flag]
    if (!key) throw new AcceptanceError('unknown argument ' + flag, 'configuration')
    values[key] = next
  }

  const baseUrl = normalizeOrigin(values.baseUrl ?? env.TENGRI_ACCEPTANCE_BASE_URL ?? DESKTOP_ORIGIN)
  const stage = stageFromValue(
    values.stage ??
      env.TENGRI_ACCEPTANCE_STAGE ??
      (env.GITHUB_REF_NAME?.startsWith('kargo/') ? env.GITHUB_REF_NAME : undefined),
  )
  const expectedRevisionValue = values.expectedRevision ?? env.TENGRI_ACCEPTANCE_EXPECTED_REVISION ?? env.GITHUB_SHA
  if (!expectedRevisionValue || !SHA40.test(expectedRevisionValue)) {
    throw new AcceptanceError('a full expected Kargo branch revision is required', 'configuration')
  }
  const expectedRevision = expectedRevisionValue.toLowerCase()
  const runId = normalizeRunId(
    values.runId ??
      env.TENGRI_ACCEPTANCE_RUN_ID ??
      (env.GITHUB_RUN_ID ? 'gha-' + env.GITHUB_RUN_ID : 'local-' + randomUUID().slice(0, 12)),
  )
  const authCookie = validateCookieHeader('TENGRI_AUTH_COOKIE', env.TENGRI_AUTH_COOKIE)
  const rejectionAuthCookie = validateCookieHeader('TENGRI_REJECTION_AUTH_COOKIE', env.TENGRI_REJECTION_AUTH_COOKIE)
  if (sha256Hex(authCookie) === sha256Hex(rejectionAuthCookie)) {
    throw new AcceptanceError('the two acceptance cookies must belong to different sessions', 'authentication')
  }
  const timeoutSeconds = parsePositiveNumber(
    values.timeoutSeconds ?? env.TENGRI_ACCEPTANCE_TIMEOUT_SECONDS,
    DEFAULT_TIMEOUT_SECONDS,
    'timeout-seconds',
    1_800,
  )
  const pollIntervalSeconds = parsePositiveNumber(
    values.pollIntervalSeconds ?? env.TENGRI_ACCEPTANCE_POLL_INTERVAL_SECONDS,
    DEFAULT_POLL_INTERVAL_SECONDS,
    'poll-interval-seconds',
    30,
  )
  const leaseFile = resolve(
    values.leaseFile ??
      env.TENGRI_ACCEPTANCE_LEASE_FILE ??
      resolve(tmpdir(), 'tengri-real-guest-acceptance', 'lease.json'),
  )
  const outputPath = resolve(
    values.outputPath ??
      env.TENGRI_ACCEPTANCE_OUTPUT ??
      resolve(tmpdir(), 'tengri-real-guest-acceptance', 'evidence.json'),
  )
  if (leaseFile === outputPath) {
    throw new AcceptanceError('Acceptance lease and evidence paths must be different', 'configuration')
  }
  return {
    baseUrl: baseUrl.baseUrl,
    origin: baseUrl.origin,
    stage,
    expectedRevision,
    runId,
    authCookie,
    rejectionAuthCookie,
    leaseFile,
    outputPath,
    timeoutMs: timeoutSeconds * 1_000,
    pollIntervalMs: pollIntervalSeconds * 1_000,
    diagnostic: env.GITHUB_EVENT_NAME === 'workflow_dispatch',
  }
}

function cookieHeaderParts(value: string): Array<{ name: string; value: string }> {
  return value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=')
      return { name: part.slice(0, separator), value: part.slice(separator + 1) }
    })
}

function splitSetCookie(value: string): string[] {
  return value.split(/,(?=\s*[^,;=\s]+=[^;,]*)/g)
}

function setCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] }
  const values = extended.getSetCookie?.()
  if (values && values.length > 0) return values
  const combined = headers.get('set-cookie')
  return combined ? splitSetCookie(combined) : []
}

export class CookieJar {
  private readonly values = new Map<string, string>()

  constructor(initialCookie?: string) {
    if (initialCookie) {
      for (const pair of cookieHeaderParts(initialCookie)) this.values.set(pair.name, pair.value)
    }
  }

  apply(headers: Headers): void {
    for (const line of setCookieHeaders(headers)) {
      const first = line.split(';', 1)[0]?.trim() ?? ''
      const separator = first.indexOf('=')
      if (separator <= 0) continue
      const name = first.slice(0, separator)
      const value = first.slice(separator + 1)
      if (!/^[^=;\s]+$/.test(name) || containsForbiddenControl(value)) continue
      const deleted = /(?:^|;)\s*max-age\s*=\s*0(?:;|$)/i.test(line)
      if (deleted) this.values.delete(name)
      else this.values.set(name, value)
    }
  }

  header(): string {
    return [...this.values.entries()].map(([name, value]) => name + '=' + value).join('; ')
  }

  has(name: string): boolean {
    return this.values.has(name)
  }
}

function makeHeaders(origin: string, jar: CookieJar, contentType = false): Headers {
  const headers = new Headers({
    Accept: 'application/json',
    Origin: origin,
    'Sec-Fetch-Site': 'same-origin',
  })
  const cookie = jar.header()
  if (cookie) headers.set('Cookie', cookie)
  if (contentType) headers.set('Content-Type', 'application/json')
  return headers
}

export async function readBodyText(
  response: Response,
  maxBytes: number,
  timeoutMs = DEFAULT_RESPONSE_BODY_TIMEOUT_MS,
  operation = 'response body',
): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const deadline = Date.now() + timeoutMs
  let timedOut = false
  try {
    while (true) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        timedOut = true
        throw new AcceptanceError(operation + ' response body timed out', operation)
      }
      const next = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => {
          timedOut = true
          rejectPromise(new AcceptanceError(operation + ' response body timed out', operation))
        }, remainingMs)
        void reader.read().then(
          (result) => {
            clearTimeout(timeout)
            resolvePromise(result)
          },
          (error: unknown) => {
            clearTimeout(timeout)
            rejectPromise(error)
          },
        )
      })
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        void reader.cancel('response body exceeded acceptance limit').catch(() => undefined)
        throw new AcceptanceError('response body exceeded acceptance limit', 'network')
      }
      chunks.push(next.value)
    }
  } catch (error) {
    if (timedOut) void reader.cancel('response body timed out').catch(() => undefined)
    throw error
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // A timed-out underlying read may still be pending after cancellation.
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged)
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
  jar: CookieJar,
  operation: string,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal })
    jar.apply(response.headers)
    return response
  } catch {
    if (controller.signal.aborted) throw new AcceptanceError(operation + ' timed out', operation)
    throw new AcceptanceError(operation + ' could not be reached', operation)
  } finally {
    clearTimeout(timeout)
  }
}

export class BffClient {
  readonly origin: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly jar: CookieJar

  constructor(
    options: Pick<AcceptanceOptions, 'baseUrl' | 'origin' | 'authCookie' | 'timeoutMs'>,
    fetchImpl?: typeof fetch,
  ) {
    this.baseUrl = options.baseUrl
    this.origin = options.origin
    this.timeoutMs = options.timeoutMs
    this.fetchImpl = fetchImpl ?? fetch
    this.jar = new CookieJar(options.authCookie)
  }

  cookieHeader(): string {
    return this.jar.header()
  }

  async snapshot(): Promise<Snapshot> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.baseUrl + BFF_PATH,
      { method: 'GET', headers: makeHeaders(this.origin, this.jar) },
      this.timeoutMs,
      this.jar,
      'desktop snapshot',
    )
    const payload = await parseJsonResponse(response, 'desktop snapshot', this.timeoutMs)
    if (!response.ok) throw new HttpFailure('desktop snapshot', response.status, stringValue(payload, 'code'))
    const record = asRecord(payload)
    if (!record) throw new AcceptanceError('desktop snapshot response is invalid', 'authentication')
    return {
      authConfigured: record.authConfigured === true,
      controlPlaneConfigured: record.controlPlaneConfigured === true,
      authenticated: record.authenticated === true,
      previewGatewayOrigin: asString(record.previewGatewayOrigin) ?? '',
      userId: asString(asRecord(record.user)?.id) ?? '',
      agents: parseAgents(record.agents),
    }
  }

  async action<T = unknown>(body: RecordLike, operation = asString(body.action) ?? 'Tengri action'): Promise<T> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.baseUrl + BFF_PATH,
      {
        method: 'POST',
        headers: makeHeaders(this.origin, this.jar, true),
        body: JSON.stringify(body),
      },
      this.timeoutMs,
      this.jar,
      operation,
    )
    const payload = await parseJsonResponse(response, operation, this.timeoutMs)
    if (!response.ok) {
      const record = asRecord(payload)
      throw new HttpFailure(operation, response.status, asString(record?.code))
    }
    const record = asRecord(payload)
    if (!record || !Object.prototype.hasOwnProperty.call(record, 'result')) {
      throw new AcceptanceError(operation + ' response is invalid', operation)
    }
    return record.result as T
  }
}

async function parseJsonResponse(response: Response, operation: string, timeoutMs: number): Promise<unknown> {
  const text = await readBodyText(response, MAX_JSON_BYTES, timeoutMs, operation)
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AcceptanceError(operation + ' returned invalid JSON', operation)
  }
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function parseAgents(value: unknown): AgentSummary[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    const record = asRecord(candidate)
    const id = asString(record?.id)
    const displayName = asString(record?.displayName)
    if (!id || !displayName) return []
    return [
      {
        id,
        displayName,
        createdAt: asString(record?.createdAt) ?? '',
        phase: asString(record?.phase) ?? 'unknown',
        message: asString(record?.message) ?? '',
      },
    ]
  })
}

function parseReadFile(value: unknown, operation: string): ReadFileResult {
  const record = asRecord(value)
  const path = requiredString(record?.path, 'read path', operation)
  const content = requiredString(record?.content, 'read content', operation)
  const revision = requiredString(record?.revision, 'read revision', operation)
  if (!/^[a-f0-9]{64}$/.test(revision))
    throw new AcceptanceError(operation + ' returned an invalid revision', operation)
  if (revision !== sha256Hex(content)) {
    throw new AcceptanceError(operation + ' returned a revision that does not match its content', operation)
  }
  return { path, content, revision }
}

function parseWriteFile(value: unknown, operation: string): WriteFileResult {
  const record = asRecord(value)
  const path = requiredString(record?.path, 'write path', operation)
  const revision = requiredString(record?.revision, 'write revision', operation)
  const size = asNumber(record?.size)
  if (size === undefined || size < 0 || !Number.isInteger(size)) {
    throw new AcceptanceError(operation + ' returned an invalid file size', operation)
  }
  if (!/^[a-f0-9]{64}$/.test(revision))
    throw new AcceptanceError(operation + ' returned an invalid revision', operation)
  return { path, size, revision }
}

function parseTerminal(value: unknown, operation: string): TerminalResult {
  const record = asRecord(value)
  const id = requiredString(record?.id, 'terminal id', operation)
  const creationId = requiredString(record?.creationId, 'terminal creation id', operation)
  return { id, creationId }
}

function parsePreview(value: unknown, operation: string): PreviewResult {
  const record = asRecord(value)
  const id = requiredString(record?.id, 'preview session id', operation)
  const launchUrl = requiredString(record?.launchUrl, 'preview launch URL', operation)
  const previewOrigin = requiredString(record?.previewOrigin, 'preview origin', operation)
  if (!PREVIEW_SESSION_ID.test(id))
    throw new AcceptanceError(operation + ' returned an invalid preview session id', operation)
  return { id, launchUrl, previewOrigin }
}

function previewOriginForSession(rawOrigin: string, sessionId: string, check: string): string {
  let url: URL
  try {
    url = new URL(rawOrigin)
  } catch {
    throw new AcceptanceError('Preview origin is invalid', check)
  }
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.hostname.startsWith('tengri-' + sessionId + '.')
  ) {
    throw new AcceptanceError('Preview origin is not bound to its issued session', check)
  }
  return url.origin
}

export function parseKustomizationDigests(stage: StageName, contents: string): StageProvenance['manifestDigests'] {
  const parsed = (YAML.parse(contents) ?? {}) as {
    configMapGenerator?: Array<{ name?: unknown; literals?: unknown }>
    images?: Array<{ name?: unknown; newName?: unknown; digest?: unknown }>
  }
  const images = Array.isArray(parsed.images) ? parsed.images : []
  if (stage === 'tengri') {
    const tengriEntries = images.filter((entry) => entry.name === TENGRI_IMAGE)
    if (tengriEntries.length !== 1) {
      throw new AcceptanceError('Tengri Kargo branch must contain one controller image entry', 'provenance')
    }
    const tengriDigest = asString(tengriEntries[0]?.digest)
    if (!tengriDigest || !DIGEST.test(tengriDigest)) {
      throw new AcceptanceError('Tengri Kargo branch controller image is not digest pinned', 'provenance')
    }
    const generators = Array.isArray(parsed.configMapGenerator) ? parsed.configMapGenerator : []
    const releaseGenerators = generators.filter((entry) => entry.name === 'tengri-release')
    if (releaseGenerators.length !== 1) {
      throw new AcceptanceError('Tengri Kargo branch must contain one release ConfigMap generator', 'provenance')
    }
    const literals = Array.isArray(releaseGenerators[0]?.literals)
      ? releaseGenerators[0]?.literals.filter((literal): literal is string => typeof literal === 'string')
      : []
    const nanoagentLiterals = literals.filter((literal) => literal.startsWith('NANOAGENT_IMAGE='))
    if (nanoagentLiterals.length !== 1) {
      throw new AcceptanceError('Tengri Kargo branch must contain one Nanoagent image literal', 'provenance')
    }
    const nanoagentMatch = nanoagentLiterals[0]?.match(
      /^NANOAGENT_IMAGE=registry\.ide-newton\.ts\.net\/lab\/nanoagent@(sha256:[0-9a-f]{64})$/,
    )
    if (!nanoagentMatch?.[1]) {
      throw new AcceptanceError('Tengri Kargo branch Nanoagent image is not digest pinned', 'provenance')
    }
    return { tengri: tengriDigest, nanoagent: nanoagentMatch[1] }
  }

  const entries = images.filter((entry) => entry.name === PROOMPTENG_IMAGE)
  if (entries.length !== 1) {
    throw new AcceptanceError('Proompteng Kargo branch must contain one image entry', 'provenance')
  }
  const digest = asString(entries[0]?.digest)
  if (!digest || !DIGEST.test(digest)) {
    throw new AcceptanceError('Proompteng Kargo branch image is not digest pinned', 'provenance')
  }
  return { proompteng: digest }
}

function promotionSourceRevision(state: RecordLike): string {
  for (const value of Object.values(state)) {
    const step = asRecord(value)
    const commits = asRecord(step?.commits)
    const source = asRecord(commits?.['./src'])
    const id = asString(source?.id) ?? asString(commits?.['./src'])
    if (id && SHA40.test(id)) return id.toLowerCase()
  }
  throw new AcceptanceError('Kargo promotion state does not expose the source revision', 'provenance')
}

function imageEntries(value: unknown): Array<RecordLike> {
  const freight = asRecord(value)
  const images = freight?.images
  return Array.isArray(images) ? images.flatMap((entry) => (asRecord(entry) ? [asRecord(entry)!] : [])) : []
}

export function parseStagePromotion(stage: StageName, value: unknown, branchRevision: string): StageProvenance {
  const root = asRecord(value)
  const status = asRecord(root?.status)
  const promotion = asRecord(status?.lastPromotion)
  const promotionStatus = asRecord(promotion?.status)
  if (!promotion || asString(promotionStatus?.phase) !== 'Succeeded') {
    throw new AcceptanceError('Kargo ' + stage + ' Stage has no successful last promotion', 'provenance')
  }
  const state = asRecord(promotionStatus?.state)
  if (!state) throw new AcceptanceError('Kargo ' + stage + ' promotion state is missing', 'provenance')
  const push = asRecord(state.push)
  const promotedBranch = asString(push?.branch)
  if (promotedBranch !== KARGO_BRANCHES[stage]) {
    throw new AcceptanceError('Kargo ' + stage + ' promotion branch is not ' + KARGO_BRANCHES[stage], 'provenance')
  }
  const commit = asRecord(state.commit)
  const promotedRevision = asString(commit?.commit)
  if (!promotedRevision || !SHA40.test(promotedRevision) || promotedRevision.toLowerCase() !== branchRevision) {
    throw new AcceptanceError('Kargo ' + stage + ' branch tip does not match its promotion commit', 'provenance')
  }
  const sourceRevision = promotionSourceRevision(state)
  const freight = asRecord(promotion.freight) ?? asRecord(promotionStatus?.freight)
  const freightName = requiredString(freight?.name, stage + ' Freight name', 'provenance')
  const images = imageEntries(freight)
  const digests: StageProvenance['digests'] = {}
  for (const image of images) {
    const repo = asString(image.repoURL)
    const digest = asString(image.digest)
    const annotations = asRecord(image.annotations)
    const annotationRevision = asString(annotations?.['org.opencontainers.image.revision'])
    if (!repo || !digest || !DIGEST.test(digest) || annotationRevision !== sourceRevision) {
      throw new AcceptanceError(
        'Kargo ' + stage + ' Freight image metadata is not immutable and source bound',
        'provenance',
      )
    }
    if (repo === TENGRI_IMAGE) digests.tengri = digest
    if (repo === NANOAGENT_IMAGE) digests.nanoagent = digest
    if (repo === PROOMPTENG_IMAGE) digests.proompteng = digest
  }
  if (stage === 'tengri' && (!digests.tengri || !digests.nanoagent)) {
    throw new AcceptanceError('Tengri Freight does not contain controller and Nanoagent digests', 'provenance')
  }
  if (stage === 'proompteng' && !digests.proompteng) {
    throw new AcceptanceError('Proompteng Freight does not contain its image digest', 'provenance')
  }
  return {
    stage,
    branch: KARGO_BRANCHES[stage],
    branchRevision,
    sourceRevision,
    freightName,
    digests,
    manifestDigests: {},
  }
}

async function defaultCommandRunner(command: string, args: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn([command, ...args], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    try {
      child.kill()
    } catch {
      // The child may have exited between the timer firing and kill().
    }
  }, COMMAND_TIMEOUT_MS)
  try {
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const exitCode = await child.exited
    if (timedOut) throw new AcceptanceError(command + ' command timed out', 'command')
    return { stdout, stderr, exitCode }
  } finally {
    clearTimeout(timeout)
  }
}

async function checkedCommand(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  check: string,
): Promise<string> {
  const result = await runner(command, args)
  if (result.exitCode !== 0) {
    throw new AcceptanceError(command + ' command failed during ' + check, check)
  }
  return result.stdout.trim()
}

async function gitRefForBranch(branch: string, runner: CommandRunner): Promise<string> {
  const current = await checkedCommand(
    runner,
    'git',
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    'provenance',
  ).catch(() => '')
  if (current === branch) return await checkedCommand(runner, 'git', ['rev-parse', 'HEAD^{commit}'], 'provenance')
  const remoteRef = 'refs/remotes/origin/' + branch
  const fetched = await runner('git', ['fetch', '--no-tags', 'origin', 'refs/heads/' + branch + ':' + remoteRef])
  if (fetched.exitCode !== 0) throw new AcceptanceError('Kargo branch ' + branch + ' is unavailable', 'provenance')
  return await checkedCommand(runner, 'git', ['rev-parse', '--verify', remoteRef + '^{commit}'], 'provenance')
}

async function gitShow(runner: CommandRunner, ref: string, path: string): Promise<string> {
  return checkedCommand(runner, 'git', ['show', ref + ':' + path], 'provenance')
}

async function kubectlJson(
  runner: CommandRunner,
  args: readonly string[],
  check: string,
  allowMissing = false,
): Promise<RecordLike | null> {
  const result = await runner('kubectl', [...args, '-o', 'json', ...(allowMissing ? ['--ignore-not-found=true'] : [])])
  if (result.exitCode !== 0) throw new AcceptanceError('Kubernetes read failed during ' + check, check)
  const stdout = result.stdout.trim()
  if (!stdout) return null
  try {
    const parsed = JSON.parse(stdout) as unknown
    return asRecord(parsed) ?? null
  } catch {
    throw new AcceptanceError('Kubernetes returned invalid JSON during ' + check, check)
  }
}

async function preflightKubernetesReads(runner: CommandRunner): Promise<void> {
  const checks: Array<{ verb: string; resource: string; namespace: string; label: string }> = [
    { verb: 'get', resource: 'stages.kargo.akuity.io/tengri', namespace: 'lab-delivery', label: 'Kargo tengri Stage' },
    {
      verb: 'get',
      resource: 'stages.kargo.akuity.io/proompteng',
      namespace: 'lab-delivery',
      label: 'Kargo proompteng Stage',
    },
    { verb: 'list', resource: 'microvms.runtime.proompteng.ai', namespace: 'tengri', label: 'MicroVM list' },
    { verb: 'get', resource: 'microvms.runtime.proompteng.ai', namespace: 'tengri', label: 'MicroVM read' },
    { verb: 'get', resource: 'persistentvolumeclaims', namespace: 'tengri', label: 'PVC read' },
    { verb: 'list', resource: 'pods', namespace: 'tengri', label: 'Pod list' },
    { verb: 'get', resource: 'pods', namespace: 'tengri', label: 'Pod read' },
    { verb: 'get', resource: 'deployments', namespace: 'tengri', label: 'Tengri Deployment read' },
    { verb: 'get', resource: 'deployments', namespace: 'proompteng', label: 'Proompteng Deployment read' },
    { verb: 'get', resource: 'applications.argoproj.io', namespace: 'argocd', label: 'Argo Application read' },
  ]
  for (const check of checks) {
    const result = await checkedCommand(
      runner,
      'kubectl',
      ['auth', 'can-i', check.verb, check.resource, '-n', check.namespace],
      'configuration',
    )
    if (result.toLowerCase() !== 'yes') {
      throw new AcceptanceError(check.label + ' permission is not granted to the acceptance runner', 'configuration')
    }
  }
}

async function resolveStageProvenance(
  stage: StageName,
  expectedRevision: string | undefined,
  runner: CommandRunner,
): Promise<StageProvenance> {
  const branch = KARGO_BRANCHES[stage]
  const branchRevision = (await gitRefForBranch(branch, runner)).toLowerCase()
  if (expectedRevision && branchRevision !== expectedRevision) {
    throw new AcceptanceError('Kargo branch ' + branch + ' does not match the expected event revision', 'provenance')
  }
  const stageObject = await kubectlJson(runner, ['-n', 'lab-delivery', 'get', 'stage', stage], 'provenance')
  if (!stageObject) throw new AcceptanceError('Kargo ' + stage + ' Stage is missing', 'provenance')
  const provenance = parseStagePromotion(stage, stageObject, branchRevision)
  const currentBranch = await runner('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const manifestRef =
    currentBranch.exitCode === 0 && currentBranch.stdout.trim() === branch ? 'HEAD' : 'refs/remotes/origin/' + branch
  provenance.manifestDigests = parseKustomizationDigests(
    stage,
    await gitShow(
      runner,
      manifestRef,
      stage === 'tengri'
        ? 'argocd/applications/tengri/kustomization.yaml'
        : 'argocd/applications/proompteng/kustomization.yaml',
    ),
  )
  for (const [name, digest] of Object.entries(provenance.digests)) {
    const manifestDigest = provenance.manifestDigests[name as keyof typeof provenance.manifestDigests]
    if (manifestDigest !== digest) {
      throw new AcceptanceError('Kargo ' + stage + ' branch digest does not match Freight metadata', 'provenance')
    }
  }
  return provenance
}

function shouldRetryProvenance(error: unknown): boolean {
  if (!(error instanceof AcceptanceError) || error.check !== 'provenance') return false
  return [
    'has no successful last promotion',
    'promotion state is missing',
    'promotion branch is not',
    'branch tip does not match its promotion commit',
    'does not expose the source revision',
    'Freight image metadata is not immutable and source bound',
    'Freight does not contain',
    'branch digest does not match Freight metadata',
  ].some((message) => error.message.includes(message))
}

async function resolveStageProvenanceWhenReady(
  stage: StageName,
  expectedRevision: string | undefined,
  runner: CommandRunner,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<StageProvenance> {
  return waitFor(
    async () => {
      try {
        return await resolveStageProvenance(stage, expectedRevision, runner)
      } catch (error) {
        if (shouldRetryProvenance(error)) return undefined
        throw error
      }
    },
    (value) => value.branchRevision.length === 40,
    timeoutMs,
    pollIntervalMs,
    'Kargo ' + stage + ' promotion provenance',
  )
}

function deploymentSelector(deployment: RecordLike): string {
  const spec = asRecord(deployment.spec)
  const selector = asRecord(spec?.selector)
  const matchLabels = asRecord(selector?.matchLabels)
  if (!matchLabels) throw new AcceptanceError('Deployment selector is missing', 'delivery')
  const values = Object.entries(matchLabels).map(([name, value]) => {
    if (typeof value !== 'string' || !value) throw new AcceptanceError('Deployment selector is invalid', 'delivery')
    return name + '=' + value
  })
  if (values.length === 0) throw new AcceptanceError('Deployment selector is empty', 'delivery')
  return values.join(',')
}

function deploymentContainer(deployment: RecordLike): { name: string; image: string } {
  const spec = asRecord(asRecord(deployment.spec)?.template)
  const podSpec = asRecord(spec?.spec)
  const containers = Array.isArray(podSpec?.containers) ? podSpec.containers : []
  const container = asRecord(containers[0])
  const name = asString(container?.name)
  const image = asString(container?.image)
  if (!name || !image) throw new AcceptanceError('Deployment image is missing', 'delivery')
  return { name, image }
}

function imageDigest(image: string, check: string, message: string): string {
  const digest = image.slice(image.lastIndexOf('@') + 1)
  if (!DIGEST.test(digest)) throw new AcceptanceError(message, check)
  return digest
}

function readyContainerImageDigests(
  pods: RecordLike,
  expectedImage: string,
  expectedContainerName: string,
): { digests: string[]; readyPods: number; nonTerminatingPods: number } {
  const expectedDigest = imageDigest(
    expectedImage,
    'delivery',
    'The promoted Deployment image is not an immutable digest reference',
  )
  const items = Array.isArray(pods.items) ? pods.items : []
  let readyPods = 0
  let nonTerminatingPods = 0
  const digests = items.flatMap((item) => {
    const pod = asRecord(item)
    const metadata = asRecord(pod?.metadata)
    if (!pod || metadata?.deletionTimestamp) return []
    nonTerminatingPods += 1
    const statuses = asRecord(pod?.status)
    const conditions = Array.isArray(statuses?.conditions) ? statuses.conditions : []
    const readyCondition = conditions.some((candidate) => {
      const condition = asRecord(candidate)
      return condition?.type === 'Ready' && condition.status === 'True'
    })
    if (!readyCondition) return []
    readyPods += 1
    const podSpec = asRecord(pod.spec)
    const podContainers = Array.isArray(podSpec?.containers) ? podSpec.containers : []
    const container = podContainers.find((candidate) => asRecord(candidate)?.name === expectedContainerName)
    if (asString(asRecord(container)?.image) !== expectedImage) {
      throw new AcceptanceError('A ready Pod does not declare the promoted immutable image', 'delivery')
    }
    const containers = Array.isArray(statuses?.containerStatuses) ? statuses.containerStatuses : []
    const containerStatus = containers.find((candidate) => asRecord(candidate)?.name === expectedContainerName)
    const status = asRecord(containerStatus)
    if (status?.ready !== true) {
      throw new AcceptanceError('A ready Pod does not report its promoted container ready', 'delivery')
    }
    const imageId = asString(status.imageID) ?? ''
    const match = imageId.match(/@(sha256:[0-9a-f]{64})$/)
    if (!match?.[1]) throw new AcceptanceError('A ready Pod does not report an immutable image ID', 'delivery')
    if (match[1] !== expectedDigest) {
      throw new AcceptanceError(
        'A ready Pod reports an unverified runtime image digest instead of the promoted OCI index',
        'delivery',
      )
    }
    return [match[1]]
  })
  return { digests, readyPods, nonTerminatingPods }
}

async function verifyDelivery(
  provenance: StageProvenance,
  application: string,
  namespace: string,
  deploymentName: string,
  expectedImage: string,
  runner: CommandRunner,
): Promise<DeliveryEvidence> {
  const app = await kubectlJson(runner, ['-n', 'argocd', 'get', 'application', application], 'delivery')
  if (!app) throw new AcceptanceError('Argo Application ' + application + ' is missing', 'delivery')
  const spec = asRecord(app.spec)
  const source = asRecord(spec?.source)
  const status = asRecord(app.status)
  const sync = asRecord(status?.sync)
  const health = asRecord(status?.health)
  const targetRevision = asString(source?.targetRevision) ?? ''
  const syncRevision = asString(sync?.revision) ?? ''
  const syncStatus = asString(sync?.status) ?? ''
  const healthStatus = asString(health?.status) ?? ''
  if (
    targetRevision !== provenance.branch ||
    syncRevision !== provenance.branchRevision ||
    syncStatus !== 'Synced' ||
    healthStatus !== 'Healthy'
  ) {
    throw new AcceptanceError(
      'Argo Application ' + application + ' is not synced and healthy at the Kargo branch tip',
      'delivery',
    )
  }
  const deployment = await kubectlJson(runner, ['-n', namespace, 'get', 'deployment', deploymentName], 'delivery')
  if (!deployment) throw new AcceptanceError('Deployment ' + deploymentName + ' is missing', 'delivery')
  const deploymentContainerInfo = deploymentContainer(deployment)
  const image = deploymentContainerInfo.image
  if (image !== expectedImage) {
    throw new AcceptanceError('Deployment ' + deploymentName + ' does not use the promoted immutable image', 'delivery')
  }
  const metadata = asRecord(deployment.metadata)
  const deploymentSpec = asRecord(deployment.spec)
  const deploymentStatus = asRecord(deployment.status)
  const generation = asNumber(metadata?.generation)
  const observedGeneration = asNumber(deploymentStatus?.observedGeneration)
  const replicas = asNumber(deploymentSpec?.replicas)
  const observedReplicas = asNumber(deploymentStatus?.replicas)
  const updatedReplicas = asNumber(deploymentStatus?.updatedReplicas)
  const readyReplicas = asNumber(deploymentStatus?.readyReplicas) ?? 0
  if (
    generation === undefined ||
    observedGeneration === undefined ||
    observedGeneration < generation ||
    replicas === undefined ||
    replicas < 1 ||
    observedReplicas !== replicas ||
    updatedReplicas !== replicas ||
    readyReplicas !== replicas
  ) {
    throw new AcceptanceError('Deployment ' + deploymentName + ' is not fully ready', 'delivery')
  }
  const pods = await kubectlJson(
    runner,
    ['-n', namespace, 'get', 'pods', '-l', deploymentSelector(deployment)],
    'delivery',
  )
  if (!pods) throw new AcceptanceError('Pod list for ' + deploymentName + ' is missing', 'delivery')
  const podEvidence = readyContainerImageDigests(pods, expectedImage, deploymentContainerInfo.name)
  if (podEvidence.readyPods !== replicas || podEvidence.nonTerminatingPods !== podEvidence.readyPods) {
    throw new AcceptanceError('Selected nonterminating Pods are not all ready at the promoted image', 'delivery')
  }
  return {
    application,
    targetRevision,
    syncRevision,
    syncStatus,
    healthStatus,
    deployment: deploymentName,
    namespace,
    image,
    readyReplicas,
    replicas,
    podImageDigests: podEvidence.digests,
  }
}

function shouldRetryDelivery(error: unknown): boolean {
  if (!(error instanceof AcceptanceError) || error.check !== 'delivery') return false
  return [
    'is missing',
    'is not synced and healthy',
    'does not use the promoted immutable image',
    'is not fully ready',
    'Pod list for',
    'No ready Pod',
    'Selected nonterminating Pods',
    'A ready Pod',
  ].some((message) => error.message.includes(message))
}

async function verifyDeliveryWhenReady(
  provenance: StageProvenance,
  application: string,
  namespace: string,
  deploymentName: string,
  expectedImage: string,
  runner: CommandRunner,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<DeliveryEvidence> {
  return waitFor(
    async () => {
      try {
        return await verifyDelivery(provenance, application, namespace, deploymentName, expectedImage, runner)
      } catch (error) {
        if (shouldRetryDelivery(error)) return undefined
        throw error
      }
    },
    (value) => value.syncRevision === provenance.branchRevision,
    timeoutMs,
    pollIntervalMs,
    'Argo ' + application + ' delivery',
  )
}

function ownerReference(resource: RecordLike, uid: string, name: string): boolean {
  const metadata = asRecord(resource.metadata)
  const owners = Array.isArray(metadata?.ownerReferences) ? metadata.ownerReferences : []
  return owners.some((value) => {
    const owner = asRecord(value)
    return owner?.controller === true && owner.kind === 'MicroVM' && owner.name === name && owner.uid === uid
  })
}

function canaryLabelSet(resource: RecordLike, agentId: string): boolean {
  const labels = asRecord(asRecord(resource.metadata)?.labels)
  return (
    labels?.['app.kubernetes.io/name'] === 'nanoagent' &&
    labels?.['app.kubernetes.io/component'] === 'microvm' &&
    labels?.['app.kubernetes.io/managed-by'] === 'tengri' &&
    labels?.['runtime.proompteng.ai/microvm'] === agentId
  )
}

function podBootstrapSecretName(pod: RecordLike): string {
  const podSpec = asRecord(pod.spec)
  const containers = Array.isArray(podSpec?.containers) ? podSpec.containers : []
  const nanoagent = containers.find((candidate) => asRecord(candidate)?.name === 'nanoagent')
  const envValue = asRecord(nanoagent)?.env
  const env: unknown[] = Array.isArray(envValue) ? envValue : []
  const bootstrap = env.find((candidate) => asRecord(candidate)?.name === 'MICROVM_BOOTSTRAP_TOKEN')
  const secretKeyRef = asRecord(asRecord(bootstrap)?.valueFrom)?.secretKeyRef
  const name = asString(asRecord(secretKeyRef)?.name)
  if (!name) throw new AcceptanceError('Canary Pod does not expose its owned bootstrap Secret reference', 'runtime')
  return name
}

async function inspectCanaryRuntime(
  agentId: string,
  expectedImage: string,
  phase: 'Ready' | 'Sleeping',
  runner: CommandRunner,
  allowMissingPod = false,
): Promise<RuntimeEvidence> {
  const microvm = await kubectlJson(
    runner,
    ['-n', 'tengri', 'get', 'microvm.runtime.proompteng.ai', agentId],
    'runtime',
    true,
  )
  if (!microvm) throw new AcceptanceError('Canary MicroVM is missing', 'runtime')
  const metadata = asRecord(microvm.metadata)
  const uid = asString(metadata?.uid)
  if (!uid || metadata?.name !== agentId) throw new AcceptanceError('Canary MicroVM identity is invalid', 'runtime')
  const spec = asRecord(microvm.spec)
  const status = asRecord(microvm.status)
  if (asString(spec?.image) !== expectedImage) {
    throw new AcceptanceError('Canary MicroVM does not use the promoted Nanoagent digest', 'runtime')
  }
  if (asString(status?.phase) !== phase) {
    throw new AcceptanceError('Canary MicroVM is not in phase ' + phase, 'runtime')
  }
  const pvcName = asString(status?.pvcName)
  if (!pvcName) throw new AcceptanceError('Canary MicroVM did not report its persistent claim', 'runtime')
  const pvc = await kubectlJson(runner, ['-n', 'tengri', 'get', 'pvc', pvcName], 'runtime', true)
  if (!pvc) throw new AcceptanceError('Canary persistent claim is missing', 'runtime')
  if (!ownerReference(pvc, uid, agentId))
    throw new AcceptanceError('Canary persistent claim owner is invalid', 'runtime')
  const pvcSpec = asRecord(pvc.spec)
  const pvcStatus = asRecord(pvc.status)
  const pvcUid = asString(asRecord(pvc.metadata)?.uid)
  const requests = asRecord(asRecord(pvcSpec?.resources)?.requests)
  if (
    pvcStatus?.phase !== 'Bound' ||
    pvcSpec?.volumeMode !== 'Block' ||
    !Array.isArray(pvcSpec?.accessModes) ||
    !pvcSpec.accessModes.includes('ReadWriteOnce') ||
    requests?.storage !== '16Gi' ||
    !pvcUid
  ) {
    throw new AcceptanceError('Canary persistent claim does not match the v2 storage contract', 'runtime')
  }
  const podName = asString(status?.podName)
  if (phase === 'Sleeping' && !podName) {
    return {
      microvmUid: uid,
      podName: '',
      podUid: '',
      pvcName,
      pvcUid,
      bootstrapSecretName: '',
      image: expectedImage,
    }
  }
  if (!podName) throw new AcceptanceError('Ready canary MicroVM did not report a Pod', 'runtime')
  const pod = await kubectlJson(runner, ['-n', 'tengri', 'get', 'pod', podName], 'runtime', true)
  if (!pod) {
    if (phase === 'Sleeping' && allowMissingPod) {
      return {
        microvmUid: uid,
        podName,
        podUid: '',
        pvcName,
        pvcUid,
        bootstrapSecretName: '',
        image: expectedImage,
      }
    }
    throw new AcceptanceError('Canary Pod is missing', 'runtime')
  }
  const podMetadata = asRecord(pod.metadata)
  const podUid = asString(podMetadata?.uid)
  const podSpec = asRecord(pod.spec)
  const containers = Array.isArray(podSpec?.containers) ? podSpec.containers : []
  const container = containers.find((candidate) => asRecord(candidate)?.name === 'nanoagent')
  const containerImage = asString(asRecord(container)?.image)
  const podStatus = asRecord(pod.status)
  const statuses = Array.isArray(podStatus?.containerStatuses) ? podStatus.containerStatuses : []
  const nanoagentStatus = statuses.find((candidate) => asRecord(candidate)?.name === 'nanoagent')
  const nanoagentStatusRecord = asRecord(nanoagentStatus)
  const imageId = asString(nanoagentStatusRecord?.imageID) ?? ''
  const imageDigestMatch = imageId.match(/@(sha256:[0-9a-f]{64})$/)
  const expectedDigest = imageDigest(expectedImage, 'runtime', 'Canary Nanoagent image is not digest pinned')
  if (
    !podUid ||
    !ownerReference(pod, uid, agentId) ||
    !canaryLabelSet(pod, agentId) ||
    podSpec?.runtimeClassName !== 'kata-fc' ||
    podSpec?.automountServiceAccountToken !== false ||
    containerImage !== expectedImage ||
    nanoagentStatus === undefined ||
    nanoagentStatusRecord?.ready !== true ||
    !imageDigestMatch?.[1]
  ) {
    throw new AcceptanceError(
      'Canary Pod does not prove the unprivileged kata-fc runtime contract and immutable image ID',
      'runtime',
    )
  }
  if (imageDigestMatch[1] !== expectedDigest) {
    throw new AcceptanceError(
      'Canary Pod reports an unverified runtime image digest instead of the promoted OCI index',
      'runtime',
    )
  }
  return {
    microvmUid: uid,
    podName,
    podUid,
    pvcName,
    pvcUid,
    bootstrapSecretName: podBootstrapSecretName(pod),
    image: expectedImage,
    podImageDigest: imageDigestMatch[1],
  }
}

function shouldRetryRuntime(error: unknown): boolean {
  if (!(error instanceof AcceptanceError) || error.check !== 'runtime') return false
  return [
    'Canary MicroVM is missing',
    'Canary MicroVM is not in phase Ready',
    'Canary persistent claim is missing',
    'Ready canary MicroVM did not report a Pod',
    'Canary Pod is missing',
  ].some((message) => error.message.includes(message))
}

async function listWorkloadImages(runner: CommandRunner): Promise<WorkloadImages> {
  const microvms = await kubectlJson(runner, ['-n', 'tengri', 'get', 'microvms.runtime.proompteng.ai'], 'runtime')
  if (!microvms) throw new AcceptanceError('MicroVM list is missing', 'runtime')
  const items = Array.isArray(microvms.items) ? microvms.items : []
  const values = new Map<string, string>()
  for (const item of items) {
    const resource = asRecord(item)
    const name = asString(asRecord(resource?.metadata)?.name)
    const image = asString(asRecord(resource?.spec)?.image)
    if (!name || !image || !DIGEST.test(image.slice(image.lastIndexOf('@') + 1))) {
      throw new AcceptanceError('MicroVM workload image inventory is not immutable', 'runtime')
    }
    values.set(name, image)
  }
  const stable = [...values.entries()].sort(([left], [right]) => left.localeCompare(right))
  return workloadImagesFromValues(values, stable)
}

function workloadImagesFromValues(
  values: Map<string, string>,
  stable = [...values.entries()].sort(([left], [right]) => left.localeCompare(right)),
): WorkloadImages {
  return {
    count: stable.length,
    fingerprint: sha256Hex(JSON.stringify(stable)),
    values,
  }
}

function withoutWorkloadImage(inventory: WorkloadImages, name: string): WorkloadImages {
  if (!inventory.values.has(name)) return inventory
  const values = new Map(inventory.values)
  values.delete(name)
  return workloadImagesFromValues(values)
}

function assertWorkloadImagesPreserved(before: WorkloadImages, after: WorkloadImages): void {
  for (const [name, image] of before.values) {
    if (after.values.get(name) !== image) {
      throw new AcceptanceError('An existing MicroVM workload image changed during canary acceptance', 'runtime')
    }
  }
}

function assertWorkloadImagesRestored(before: WorkloadImages, after: WorkloadImages): void {
  assertWorkloadImagesPreserved(before, after)
  if (before.count !== after.count || before.fingerprint !== after.fingerprint) {
    throw new AcceptanceError('The MicroVM workload inventory was not restored after canary cleanup', 'cleanup')
  }
}

export function validateLeaseRecord(value: unknown, ownerFingerprint: string): LeaseRecord {
  const record = asRecord(value)
  if (
    record?.version !== 3 ||
    record.tool !== 'tengri-real-guest-acceptance' ||
    typeof record.agentId !== 'string' ||
    !AGENT_ID.test(record.agentId) ||
    typeof record.displayName !== 'string' ||
    !record.displayName.startsWith('tengri-acceptance-') ||
    typeof record.agentCreatedAt !== 'string' ||
    record.agentCreatedAt.length === 0 ||
    (record.microvmUid !== undefined &&
      (typeof record.microvmUid !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(record.microvmUid))) ||
    typeof record.leaseId !== 'string' ||
    !LEASE_ID.test(record.leaseId) ||
    record.ownerFingerprint !== ownerFingerprint ||
    typeof record.createdAt !== 'string' ||
    typeof record.firstRunId !== 'string' ||
    !SAFE_RUN_ID.test(record.firstRunId) ||
    typeof record.terminalCreationId !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(record.terminalCreationId) ||
    !Array.isArray(record.previewSessionIds) ||
    record.previewSessionIds.some((id) => typeof id !== 'string' || !PREVIEW_SESSION_ID.test(id))
  ) {
    throw new AcceptanceError('Acceptance lease is invalid or belongs to another identity', 'safety')
  }
  const expectedPrefix = 'tengri-acceptance:v1:' + record.agentId + ':' + record.leaseId + ':'
  if (
    (record.filePath !== undefined &&
      (typeof record.filePath !== 'string' ||
        !record.filePath.startsWith('/workspace/') ||
        containsForbiddenControl(record.filePath) ||
        record.filePath.split('/').includes('..'))) ||
    (record.filePrefix !== undefined &&
      (typeof record.filePrefix !== 'string' || !record.filePrefix.startsWith(expectedPrefix))) ||
    (record.fileContentSha256 !== undefined &&
      (typeof record.fileContentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.fileContentSha256))) ||
    (record.terminalId !== undefined &&
      (typeof record.terminalId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.terminalId)))
  ) {
    throw new AcceptanceError('Acceptance lease contains an unsafe owned resource reference', 'safety')
  }
  const lease: LeaseRecord = {
    version: 3,
    tool: 'tengri-real-guest-acceptance',
    agentId: record.agentId,
    displayName: record.displayName,
    agentCreatedAt: record.agentCreatedAt,
    leaseId: record.leaseId,
    ownerFingerprint,
    createdAt: record.createdAt,
    firstRunId: record.firstRunId,
    terminalCreationId: record.terminalCreationId,
    previewSessionIds: [...record.previewSessionIds],
  }
  if (typeof record.microvmUid === 'string') lease.microvmUid = record.microvmUid
  if (typeof record.filePath === 'string') lease.filePath = record.filePath
  if (typeof record.filePrefix === 'string') lease.filePrefix = record.filePrefix
  if (typeof record.fileContentSha256 === 'string') lease.fileContentSha256 = record.fileContentSha256
  if (typeof record.terminalId === 'string') lease.terminalId = record.terminalId
  return lease
}

function writeLease(path: string, lease: LeaseRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.tmp-' + String(process.pid) + '-' + randomUUID()
  try {
    writeFileSync(temporary, JSON.stringify(lease) + '\n', { encoding: 'utf8', mode: 0o600 })
    const fileDescriptor = openSync(temporary, 'r')
    try {
      fsyncSync(fileDescriptor)
    } finally {
      closeSync(fileDescriptor)
    }
    renameSync(temporary, path)
    const directoryDescriptor = openSync(dirname(path), 'r')
    try {
      fsyncSync(directoryDescriptor)
    } finally {
      closeSync(directoryDescriptor)
    }
  } catch {
    try {
      unlinkSync(temporary)
    } catch {
      // Preserve the original write failure.
    }
    throw new AcceptanceError('could not persist the acceptance lease', 'safety')
  }
}

function readLease(path: string, ownerFingerprint: string): LeaseRecord | undefined {
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    throw new AcceptanceError('acceptance lease is not valid JSON', 'safety')
  }
  return validateLeaseRecord(parsed, ownerFingerprint)
}

function createLease(
  agentId: string,
  displayName: string,
  agentCreatedAt: string,
  ownerFingerprint: string,
  runId: string,
): LeaseRecord {
  const leaseId = randomUUID().replace(/-/g, '').slice(0, 16)
  return {
    version: 3,
    tool: 'tengri-real-guest-acceptance',
    agentId,
    displayName,
    agentCreatedAt,
    leaseId,
    ownerFingerprint,
    createdAt: new Date().toISOString(),
    firstRunId: runId,
    terminalCreationId: 'tengri-acceptance-' + agentId + '-' + leaseId,
    previewSessionIds: [],
    filePrefix: 'tengri-acceptance:v1:' + agentId + ':' + leaseId + ':',
  }
}

function updateLease(path: string, lease: LeaseRecord): void {
  writeLease(path, lease)
}

async function waitFor<T>(
  operation: () => Promise<T | undefined>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  intervalMs: number,
  check: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await operation()
    if (value !== undefined && predicate(value)) return value
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
  }
  throw new AcceptanceError(check + ' did not reach the expected state before timeout', check)
}

function waitDelay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

export function parseTerminalOutputFrame(
  value: ArrayBuffer | Uint8Array,
): { sequence: number; payload: Uint8Array } | null {
  const frame = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (frame.byteLength < 6 || frame[0] !== 1) return null
  const sequence = new DataView(frame.buffer, frame.byteOffset + 1, 4).getUint32(0, false)
  if (sequence === 0) return null
  return { sequence, payload: frame.subarray(5) }
}

function probeMarker(prefix: string): string {
  return prefix + '_' + randomUUID().replaceAll('-', '')
}

export function markerCommand(marker: string): string {
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(marker)) {
    throw new AcceptanceError('Probe marker is invalid', 'pty')
  }
  const split = Math.ceil(marker.length / 2)
  const left = marker.slice(0, split)
  const right = marker.slice(split)
  return "printf '%s%s\\n' '" + left + "' '" + right + "'\n"
}

type TerminalControl =
  | { type: 'ready'; token: string; bufferEnd: number }
  | { type: 'error'; message: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'pong' }

function parseTerminalControl(value: string): TerminalControl | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return null
  }
  const record = asRecord(parsed)
  if (!record || typeof record.type !== 'string') return null
  if (record.type === 'pong') return { type: 'pong' }
  if (record.type === 'error') return { type: 'error', message: 'terminal reported an error' }
  if (record.type === 'exit') {
    return { type: 'exit', exitCode: asNumber(record.exitCode) ?? -1 }
  }
  if (
    record.type === 'ready' &&
    typeof record.token === 'string' &&
    /^[A-Za-z0-9_-]{16,128}$/.test(record.token) &&
    asNumber(record.bufferEnd) !== undefined
  ) {
    return { type: 'ready', token: record.token, bufferEnd: asNumber(record.bufferEnd)! }
  }
  return null
}

function terminalUrl(raw: string, reconnectToken: string, since: number): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AcceptanceError('terminal ticket URL is invalid', 'pty')
  }
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:')
    throw new AcceptanceError('terminal ticket URL is invalid', 'pty')
  if (url.protocol === 'ws:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new AcceptanceError('terminal ticket URL must use secure WebSocket outside localhost', 'pty')
  }
  if (url.username || url.password || url.hash) throw new AcceptanceError('terminal ticket URL is invalid', 'pty')
  if (reconnectToken) url.searchParams.set('reconnect', reconnectToken)
  else url.searchParams.delete('reconnect')
  if (since > 0) url.searchParams.set('since', String(since))
  else url.searchParams.delete('since')
  url.searchParams.set('cols', '120')
  url.searchParams.set('rows', '32')
  return url.toString()
}

function openWebSocket(url: string, options: Bun.WebSocketOptions): WebSocket {
  const Constructor = WebSocket as unknown as new (target: string, options: Bun.WebSocketOptions) => WebSocket
  return new Constructor(url, options)
}

async function runTerminalCommand(
  client: BffClient,
  agentId: string,
  terminalId: string,
  command: string,
  marker: string,
  timeoutMs: number,
  reconnectToken = '',
  since = 0,
): Promise<{ reconnectToken: string; lastSequence: number }> {
  const ticketResult = await client.action<RecordLike>(
    { action: 'terminal-ticket', agentId, terminalId },
    'terminal ticket',
  )
  const websocketUrl = requiredString(ticketResult.websocketUrl, 'terminal WebSocket URL', 'pty')
  const ticket = requiredString(ticketResult.ticket, 'terminal ticket', 'pty')
  const socket = openWebSocket(terminalUrl(websocketUrl, reconnectToken, since), {
    protocols: ['tengri.ticket.' + ticket],
    headers: { Origin: client.origin },
  })
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let readyToken = ''
    let lastSequence = since
    let opened = false
    let outputBuffer = ''
    const timeout = setTimeout(() => {
      finish(new AcceptanceError('terminal marker was not observed before timeout', 'pty'))
    }, timeoutMs)

    const close = () => {
      try {
        socket.close(1000, 'acceptance complete')
      } catch {
        // The socket may already be closed by the gateway.
      }
    }
    const finish = (error?: AcceptanceError) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      close()
      if (error) rejectPromise(error)
      else resolvePromise({ reconnectToken: readyToken, lastSequence })
    }
    const sendCommand = () => {
      if (!opened || !readyToken || !command) return
      try {
        socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 32 }))
        socket.send(new TextEncoder().encode(command))
      } catch {
        finish(new AcceptanceError('terminal input could not be sent', 'pty'))
      }
    }
    const consume = async (value: unknown) => {
      if (settled) return
      if (typeof value === 'string') {
        const control = parseTerminalControl(value)
        if (!control) return
        if (control.type === 'ready') {
          readyToken = control.token
          sendCommand()
        } else if (control.type === 'error') {
          finish(new AcceptanceError('terminal gateway reported an error', 'pty'))
        } else if (control.type === 'exit' && control.exitCode !== 0) {
          finish(new AcceptanceError('terminal process exited before its marker', 'pty'))
        }
        return
      }
      let bytes: Uint8Array | undefined
      if (value instanceof ArrayBuffer) bytes = new Uint8Array(value)
      else if (value instanceof Uint8Array) bytes = value
      else if (value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer())
      if (!bytes) return
      const frame = parseTerminalOutputFrame(bytes)
      if (!frame) return
      lastSequence = Math.max(lastSequence, frame.sequence)
      const output = new TextDecoder('utf-8', { fatal: false }).decode(frame.payload)
      outputBuffer = (outputBuffer + output).slice(-MAX_TERMINAL_OUTPUT_BYTES)
      if (outputBuffer.includes(marker)) finish()
    }
    socket.addEventListener('open', () => {
      opened = true
      sendCommand()
    })
    socket.addEventListener('message', (event) => {
      void consume(event.data).catch(() => {
        finish(new AcceptanceError('terminal output could not be decoded', 'pty'))
      })
    })
    socket.addEventListener('error', () => {
      finish(new AcceptanceError('terminal WebSocket failed', 'pty'))
    })
    socket.addEventListener('close', () => {
      if (!settled) finish(new AcceptanceError('terminal WebSocket closed before its marker', 'pty'))
    })
  })
}

function parseAgent(value: unknown, operation: string): AgentSummary {
  const record = asRecord(value)
  const id = requiredString(record?.id, 'agent id', operation)
  const displayName = requiredString(record?.displayName, 'agent display name', operation)
  const createdAt = requiredString(record?.createdAt, 'agent creation timestamp', operation)
  if (!AGENT_ID.test(id)) throw new AcceptanceError(operation + ' returned an invalid agent id', operation)
  return {
    id,
    displayName,
    createdAt,
    phase: asString(record?.phase) ?? 'unknown',
    message: asString(record?.message) ?? '',
  }
}

function parseTerminalAction(value: unknown, operation: string): TerminalResult {
  return parseTerminal(value, operation)
}

function parsePreviewAction(value: unknown, operation: string): PreviewResult {
  return parsePreview(value, operation)
}

function filePathForLease(lease: LeaseRecord): string {
  if (lease.filePath) return lease.filePath
  return '/workspace/.tengri-acceptance-' + lease.leaseId + '.txt'
}

function filePrefixForLease(lease: LeaseRecord): string {
  return lease.filePrefix ?? 'tengri-acceptance:v1:' + lease.agentId + ':' + lease.leaseId + ':'
}

function ensureLeaseFilePath(path: string): void {
  if (!path.startsWith('/workspace/')) {
    throw new AcceptanceError('Acceptance file must stay under /workspace', 'file-cas')
  }
}

type ExecutionState = {
  options: AcceptanceOptions
  runner: CommandRunner
  fetchImpl: typeof fetch
  primary: BffClient
  rejection: BffClient
  evidence: Evidence
  lease?: LeaseRecord
  leaseDurable: boolean
  agent?: AgentSummary
  runtime?: RuntimeEvidence
  baselineWorkloads?: WorkloadImages
  fileOwned: boolean
  filePath?: string
  fileContentSha256?: string
  terminalId?: string
  previewSessionIds: string[]
  previewGatewayOrigin: string
  activeCheck: string
  creationLeaseStore?: CreationLeaseStore
}

function setCheck(evidence: Evidence, name: string, status: AcceptanceCheckStatus, detail?: string): void {
  evidence.checks[name] = detail ? { status, detail } : { status }
}

function newEvidence(options: AcceptanceOptions): Evidence {
  return {
    schemaVersion: 1,
    status: 'running',
    acceptance: 'incomplete',
    diagnostic: options.diagnostic,
    startedAt: new Date().toISOString(),
    stage: options.stage,
    expectedEventRevision: options.expectedRevision,
    provenance: {},
    delivery: {},
    checks: {
      configuration: { status: 'not_run' },
      provenance: { status: 'not_run' },
      authentication: { status: 'not_run' },
      delivery: { status: 'not_run' },
      runtime: { status: 'not_run' },
      fileCas: { status: 'not_run' },
      pty: { status: 'not_run' },
      preview: { status: 'not_run' },
      ownerBoundary: { status: 'not_run' },
      sleepResume: { status: 'not_run' },
      cleanup: { status: 'not_run' },
      codexAccount: { status: 'not_run' },
    },
    codexAccount: { status: 'not_run' },
  }
}

function persistEvidence(evidence: Evidence, path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const safe = JSON.stringify(evidence, null, 2) + '\n'
  const temporary = path + '.tmp-' + String(process.pid) + '-' + randomUUID()
  try {
    writeFileSync(temporary, safe, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Preserve the original evidence write failure.
    }
    throw error
  }
}

function checkpointEvidence(evidence: Evidence, path: string): void {
  try {
    persistEvidence(evidence, path)
  } catch {
    throw new AcceptanceError('could not persist an acceptance evidence checkpoint', 'evidence')
  }
}

function preflightPersistence(options: AcceptanceOptions): void {
  const probePaths: string[] = []
  try {
    for (const path of [options.leaseFile, options.outputPath]) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const probePath = path + '.probe-' + String(process.pid) + '-' + randomUUID()
      probePaths.push(probePath)
      const renamedPath = probePath + '.renamed'
      writeFileSync(probePath, 'tengri acceptance persistence probe\n', {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      renameSync(probePath, renamedPath)
      unlinkSync(renamedPath)
    }
  } catch {
    for (const probePath of probePaths) {
      try {
        unlinkSync(probePath)
      } catch {
        // Preserve the original preflight failure.
      }
      try {
        unlinkSync(probePath + '.renamed')
      } catch {
        // Preserve the original preflight failure.
      }
    }
    throw new AcceptanceError('Acceptance lease and evidence paths are not writable', 'configuration')
  }
}

export async function ensureCanaryLease(state: ExecutionState, initialSnapshot: Snapshot): Promise<AgentSummary> {
  const fingerprint = ownerFingerprint(initialSnapshot.userId)
  const existing = readLease(state.options.leaseFile, fingerprint)
  if (existing) {
    state.lease = existing
    state.leaseDurable = true
    state.fileOwned = Boolean(existing.filePath && existing.fileContentSha256)
    state.previewSessionIds = [...existing.previewSessionIds]
    const agent = initialSnapshot.agents.find((candidate) => candidate.id === existing.agentId)
    if (!agent || agent.displayName !== existing.displayName || agent.createdAt !== existing.agentCreatedAt) {
      throw new AcceptanceError(
        'Acceptance lease does not resolve to the original canary incarnation under this session',
        'safety',
      )
    }
    state.agent = agent
    return agent
  }
  if (initialSnapshot.agents.length > 0) {
    throw new AcceptanceError(
      'Dedicated acceptance identity already owns an agent; provide its explicit lease file before running',
      'safety',
    )
  }
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10)
  const displayName = ('tengri-acceptance-' + state.options.runId + '-' + suffix).slice(0, 64)
  const created = parseAgent(
    await state.primary.action({ action: 'create-agent', displayName }, 'create agent'),
    'create agent',
  )
  if (initialSnapshot.agents.some((candidate) => candidate.id === created.id)) {
    throw new AcceptanceError('Create Agent returned a pre-existing identity', 'safety')
  }
  if (created.displayName !== displayName) {
    throw new AcceptanceError('Create Agent did not return the requested canary identity', 'safety')
  }
  const lease = createLease(created.id, created.displayName, created.createdAt, fingerprint, state.options.runId)
  state.lease = lease
  state.agent = created
  state.evidence.canary = {
    agentId: created.id,
    displayName: created.displayName,
    image: '',
  }
  updateLease(state.options.leaseFile, lease)
  state.leaseDurable = true
  if (state.creationLeaseStore) {
    await verifyLeaseIncarnation(state)
    if (!lease.microvmUid) throw new AcceptanceError('Created canary has no MicroVM UID', 'safety')
    await state.creationLeaseStore.save(ownerFingerprint(initialSnapshot.userId), {
      agentId: created.id,
      displayName: created.displayName,
      agentCreatedAt: created.createdAt,
      microvmUid: lease.microvmUid,
    })
  }
  return created
}

export async function recoverInterruptedCanary(state: ExecutionState, snapshot: Snapshot): Promise<Snapshot> {
  if (!state.creationLeaseStore) return snapshot
  if (snapshot.agents.length > 1) throw new AcceptanceError('Dedicated identity has multiple agents', 'safety')
  const recovered = await state.creationLeaseStore.latest(ownerFingerprint(snapshot.userId))
  if (!recovered) {
    if (snapshot.agents.length) throw new AcceptanceError('Existing agent has no durable creation lease', 'safety')
    return snapshot
  }
  const identity = recovered.lease.canary
  const agent = snapshot.agents[0]
  const matches = (candidate: AgentSummary) =>
    candidate.id === identity.agentId &&
    candidate.createdAt === identity.agentCreatedAt &&
    candidate.displayName === identity.displayName
  if (agent && !matches(agent))
    throw new AcceptanceError('Existing agent differs from the durable creation lease', 'safety')
  const baseline = withoutWorkloadImage(await listWorkloadImages(state.runner), identity.agentId)
  const resources = [
    { kind: 'microvm.runtime.proompteng.ai', name: identity.agentId, parent: true },
    { kind: 'pod', name: identity.agentId, parent: false },
    { kind: 'pvc', name: identity.agentId + '-home', parent: false },
  ] as const
  const readResource = async (resource: (typeof resources)[number]) => {
    const value = await kubectlJson(
      state.runner,
      ['-n', 'tengri', 'get', resource.kind, resource.name],
      'recovery',
      true,
    )
    if (value) {
      const metadata = asRecord(value.metadata)
      if (
        resource.parent
          ? metadata?.uid !== identity.microvmUid
          : !ownerReference(value, identity.microvmUid, identity.agentId)
      ) {
        throw new AcceptanceError('Prior canary resource belongs to a different incarnation', 'safety')
      }
    }
    return value
  }
  for (const resource of resources) await readResource(resource)
  if (agent) {
    // A failed run may have deliberately retained changed data. Only abrupt job
    // interruption authorizes automatic disposal; reported failures require review.
    if (recovered.conclusion !== 'cancelled' && recovered.conclusion !== 'timed_out') {
      throw new AcceptanceError(
        'Prior canary was retained after a completed failure; operator review is required',
        'safety',
      )
    }
    const fresh = await requireAuthenticatedSnapshot(state.primary, 'recovery identity')
    if (
      fresh.userId !== snapshot.userId ||
      fresh.agents.length !== 1 ||
      !fresh.agents[0] ||
      !matches(fresh.agents[0])
    ) {
      throw new AcceptanceError('Canary owner or incarnation changed before recovery', 'safety')
    }
    const microvm = await readResource(resources[0])
    if (!microvm) throw new AcceptanceError('Prior canary MicroVM is missing before recovery', 'safety')
    await state.primary.action({ action: 'delete-agent', agentId: identity.agentId }, 'delete interrupted canary')
  }
  // A previous delete can outlive its runner. Verify garbage collection before
  // reusing this owner's deterministic agent name and persistent claim name.
  for (const resource of resources) {
    await waitFor(
      () => readResource(resource),
      (value) => value === null,
      Math.min(state.options.timeoutMs, 120_000),
      state.options.pollIntervalMs,
      'prior canary ' + resource.kind + ' cleanup',
    )
  }
  assertWorkloadImagesRestored(baseline, await listWorkloadImages(state.runner))
  const fresh = await requireAuthenticatedSnapshot(state.primary, 'recovered identity')
  if (fresh.userId !== snapshot.userId || fresh.agents.length) {
    throw new AcceptanceError('Dedicated identity is not empty after canary recovery', 'safety')
  }
  if (existsSync(state.options.leaseFile)) {
    const local = readLease(state.options.leaseFile, ownerFingerprint(snapshot.userId))
    if (
      !local ||
      local.agentId !== identity.agentId ||
      local.agentCreatedAt !== identity.agentCreatedAt ||
      local.microvmUid !== identity.microvmUid
    )
      throw new AcceptanceError('Local and durable canary leases disagree', 'safety')
    unlinkSync(state.options.leaseFile)
  }
  setCheck(state.evidence, 'recovery', 'passed')
  return fresh
}

async function requireAuthenticatedSnapshot(client: BffClient, label: string): Promise<Snapshot> {
  const snapshot = await client.snapshot()
  if (!snapshot.authConfigured || !snapshot.controlPlaneConfigured || !snapshot.authenticated) {
    throw new AcceptanceError(label + ' is not authenticated and control-plane configured', 'authentication')
  }
  return snapshot
}

async function waitForAgentPhase(state: ExecutionState, phase: string): Promise<AgentSummary> {
  return waitFor(
    async () => {
      const snapshot = await state.primary.snapshot()
      const agent = snapshot.agents.find((candidate) => candidate.id === state.agent?.id)
      if (agent?.phase === 'failed') {
        throw new AcceptanceError('Canary agent entered failed phase', 'runtime')
      }
      return agent
    },
    (agent) => agent.phase === phase,
    state.options.timeoutMs,
    state.options.pollIntervalMs,
    'canary agent phase ' + phase,
  )
}

async function inspectReadyRuntime(state: ExecutionState, expectedImage: string): Promise<RuntimeEvidence> {
  const runtime = await waitFor(
    async () => {
      try {
        return await inspectCanaryRuntime(state.agent?.id ?? '', expectedImage, 'Ready', state.runner, true)
      } catch (error) {
        if (shouldRetryRuntime(error)) return undefined
        throw error
      }
    },
    (runtime) => runtime.podUid.length > 0,
    Math.min(state.options.timeoutMs, 120_000),
    state.options.pollIntervalMs,
    'ready canary runtime',
  )
  const lease = state.lease
  if (!lease) throw new AcceptanceError('Canary lease is missing', 'safety')
  if (lease.microvmUid && lease.microvmUid !== runtime.microvmUid) {
    throw new AcceptanceError('Canary MicroVM incarnation changed under the acceptance lease', 'safety')
  }
  if (!lease.microvmUid) {
    lease.microvmUid = runtime.microvmUid
    updateLease(state.options.leaseFile, lease)
  }
  return runtime
}

async function readOwnedFile(state: ExecutionState, path: string): Promise<ReadFileResult | undefined> {
  try {
    const result = parseReadFile(
      await state.primary.action({ action: 'read-file', agentId: state.agent?.id, path }, 'read file'),
      'read file',
    )
    if (result.path !== path) throw new AcceptanceError('read file returned an unexpected path', 'file-cas')
    return result
  } catch (error) {
    if (error instanceof HttpFailure && error.status === 404) return undefined
    throw error
  }
}

async function verifyLeaseIncarnation(state: ExecutionState): Promise<void> {
  const lease = state.lease
  if (!lease || !state.agent) throw new AcceptanceError('Acceptance lease is missing', 'safety')
  const snapshot = await requireAuthenticatedSnapshot(state.primary, 'cleanup identity')
  const agent = snapshot.agents.find((candidate) => candidate.id === lease.agentId)
  if (!agent || agent.displayName !== lease.displayName || agent.createdAt !== lease.agentCreatedAt) {
    throw new AcceptanceError('Acceptance lease does not resolve to the original canary incarnation', 'safety')
  }
  const microvm = await kubectlJson(
    state.runner,
    ['-n', 'tengri', 'get', 'microvm.runtime.proompteng.ai', lease.agentId],
    'cleanup',
    true,
  )
  if (!microvm) {
    if (lease.microvmUid || state.runtime?.microvmUid) {
      throw new AcceptanceError('Acceptance lease MicroVM is missing; canary was retained', 'safety')
    }
    return
  }
  const microvmUid = asString(asRecord(microvm.metadata)?.uid)
  if (!microvmUid) throw new AcceptanceError('Acceptance MicroVM UID is missing; canary was retained', 'safety')
  if (lease.microvmUid && lease.microvmUid !== microvmUid) {
    throw new AcceptanceError('Acceptance lease MicroVM incarnation changed; canary was retained', 'safety')
  }
  if (!lease.microvmUid) {
    lease.microvmUid = microvmUid
    if (state.leaseDurable) updateLease(state.options.leaseFile, lease)
  }
}

async function verifyOwnedFileBeforeCleanup(state: ExecutionState): Promise<void> {
  const lease = state.lease
  const filePath = state.filePath ?? lease?.filePath
  const expectedFileSha = state.fileContentSha256 ?? lease?.fileContentSha256
  if (!filePath && !expectedFileSha && !state.fileOwned) return
  if (!state.fileOwned || !filePath || !expectedFileSha) {
    throw new AcceptanceError('Acceptance file ownership is unverified; canary was retained', 'safety')
  }
  const current = await readOwnedFile(state, filePath)
  if (!current) throw new AcceptanceError('Acceptance file is missing; canary was retained', 'safety')
  if (sha256Hex(current.content) !== expectedFileSha) {
    throw new AcceptanceError('Acceptance file changed; canary was retained for operator review', 'safety')
  }
}

async function runFileCas(state: ExecutionState): Promise<void> {
  const lease = state.lease
  if (!lease) throw new AcceptanceError('Canary lease is missing', 'file-cas')
  const path = filePathForLease(lease)
  const prefix = filePrefixForLease(lease)
  ensureLeaseFilePath(path)
  if (!lease.filePath || !lease.filePrefix) {
    lease.filePath = path
    lease.filePrefix = prefix
    updateLease(state.options.leaseFile, lease)
  }
  state.filePath = path
  const existing = await readOwnedFile(state, path)
  let expectedRevision = 'missing'
  if (existing) {
    if (!existing.content.startsWith(prefix)) {
      throw new AcceptanceError('Acceptance file already exists with content outside this lease', 'file-cas')
    }
    expectedRevision = existing.revision
  }
  const firstContent = prefix + 'first:' + state.options.runId + '\n'
  const secondContent = prefix + 'second:' + state.options.runId + '\n'
  const first = parseWriteFile(
    await state.primary.action(
      {
        action: 'write-file',
        agentId: state.agent?.id,
        path,
        content: firstContent,
        expectedRevision,
      },
      'CAS first write',
    ),
    'CAS first write',
  )
  if (
    first.path !== path ||
    first.size !== new TextEncoder().encode(firstContent).byteLength ||
    first.revision !== sha256Hex(firstContent)
  ) {
    throw new AcceptanceError('CAS first write was not confirmed by its revision', 'file-cas')
  }
  const second = parseWriteFile(
    await state.primary.action(
      {
        action: 'write-file',
        agentId: state.agent?.id,
        path,
        content: secondContent,
        expectedRevision: first.revision,
      },
      'CAS second write',
    ),
    'CAS second write',
  )
  if (
    second.path !== path ||
    second.size !== new TextEncoder().encode(secondContent).byteLength ||
    second.revision !== sha256Hex(secondContent)
  ) {
    throw new AcceptanceError('CAS second write was not confirmed by its revision', 'file-cas')
  }
  let conflictStatus = 0
  try {
    await state.primary.action(
      {
        action: 'write-file',
        agentId: state.agent?.id,
        path,
        content: prefix + 'stale:\n',
        expectedRevision: first.revision,
      },
      'CAS stale write',
    )
    throw new AcceptanceError('CAS stale write unexpectedly succeeded', 'file-cas')
  } catch (error) {
    if (!(error instanceof HttpFailure) || error.status !== 409) throw error
    conflictStatus = error.status
  }
  const verified = await readOwnedFile(state, path)
  if (!verified || verified.content !== secondContent || verified.revision !== second.revision) {
    throw new AcceptanceError('CAS readback did not preserve the winning write', 'file-cas')
  }
  const listing = asRecord(
    await state.primary.action({ action: 'list-files', agentId: state.agent?.id, path: '/workspace' }, 'list files'),
  )
  const entries = Array.isArray(listing?.entries) ? listing.entries : []
  const entry = entries.find((candidate) => asRecord(candidate)?.path === path)
  if (!entry || asNumber(asRecord(entry)?.size) !== new TextEncoder().encode(secondContent).byteLength) {
    throw new AcceptanceError('CAS file is not present in the workspace listing', 'file-cas')
  }
  const contentSha256 = sha256Hex(secondContent)
  state.fileOwned = true
  state.fileContentSha256 = contentSha256
  lease.fileContentSha256 = contentSha256
  updateLease(state.options.leaseFile, lease)
  state.evidence.canary = {
    ...(state.evidence.canary ?? {
      agentId: state.agent?.id ?? '',
      displayName: state.agent?.displayName ?? '',
      image: state.runtime?.image ?? '',
    }),
    file: {
      path,
      bytes: new TextEncoder().encode(secondContent).byteLength,
      revision: second.revision,
      contentSha256,
      conflictStatus,
    },
  }
}

async function ensureTerminal(state: ExecutionState): Promise<TerminalResult> {
  const lease = state.lease
  if (!lease) throw new AcceptanceError('Canary lease is missing', 'pty')
  const list = asRecord(
    await state.primary.action({ action: 'list-terminals', agentId: state.agent?.id }, 'list terminals'),
  )
  const sessions = Array.isArray(list?.sessions) ? list.sessions : []
  const owned = sessions.filter((candidate) => asRecord(candidate)?.creationId === lease.terminalCreationId)
  if (owned.length > 1) throw new AcceptanceError('Multiple terminals match the acceptance lease', 'safety')
  if (owned.length === 1) {
    const terminal = parseTerminalAction(owned[0], 'list terminals')
    state.terminalId = terminal.id
    lease.terminalId = terminal.id
    updateLease(state.options.leaseFile, lease)
    return terminal
  }
  const terminal = parseTerminalAction(
    await state.primary.action(
      {
        action: 'create-terminal',
        agentId: state.agent?.id,
        creationId: lease.terminalCreationId,
        cwd: '/',
        columns: 120,
        rows: 32,
      },
      'create terminal',
    ),
    'create terminal',
  )
  if (terminal.creationId !== lease.terminalCreationId) {
    throw new AcceptanceError('Create Terminal returned an unexpected creation identity', 'safety')
  }
  state.terminalId = terminal.id
  lease.terminalId = terminal.id
  updateLease(state.options.leaseFile, lease)
  return terminal
}

async function runPtyCheck(state: ExecutionState): Promise<void> {
  const terminal = await ensureTerminal(state)
  const roundTripMarker = probeMarker('TENGRI_PTY_ROUNDTRIP')
  const first = await runTerminalCommand(
    state.primary,
    state.agent?.id ?? '',
    terminal.id,
    markerCommand(roundTripMarker),
    roundTripMarker,
    state.options.timeoutMs,
  )
  await waitDelay(100)
  const reconnectMarker = probeMarker('TENGRI_PTY_RECONNECTED')
  await runTerminalCommand(
    state.primary,
    state.agent?.id ?? '',
    terminal.id,
    markerCommand(reconnectMarker),
    reconnectMarker,
    state.options.timeoutMs,
    first.reconnectToken,
    first.lastSequence,
  )
  state.evidence.canary = {
    ...(state.evidence.canary ?? {
      agentId: state.agent?.id ?? '',
      displayName: state.agent?.displayName ?? '',
      image: state.runtime?.image ?? '',
    }),
    terminal: {
      creationId: state.lease?.terminalCreationId ?? '',
      terminalId: terminal.id,
    },
  }
}

async function externalRequest(
  state: ExecutionState,
  url: string,
  init: RequestInit,
  jar: CookieJar,
  operation: string,
): Promise<Response> {
  const headers = new Headers(init.headers)
  const cookie = jar.header()
  if (cookie) headers.set('Cookie', cookie)
  const response = await fetchWithTimeout(
    state.fetchImpl,
    url,
    { ...init, headers },
    state.options.timeoutMs,
    jar,
    operation,
  )
  return response
}

function previewTokenFromHash(rawUrl: string, check: string): { url: URL; token: string } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new AcceptanceError('Preview URL is invalid', check)
  }
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    !url.hash
  ) {
    throw new AcceptanceError('Preview URL is not a secure token URL', check)
  }
  const encoded = url.hash.slice(1)
  let token: string
  try {
    token = decodeURIComponent(encoded)
  } catch {
    throw new AcceptanceError('Preview URL token is invalid', check)
  }
  if (!token || token.length > 4096 || containsForbiddenControl(token)) {
    throw new AcceptanceError('Preview URL token is invalid', check)
  }
  url.hash = ''
  return { url, token }
}

async function parseExternalJson(response: Response, operation: string, timeoutMs: number): Promise<RecordLike> {
  const text = await readBodyText(response, MAX_JSON_BYTES, timeoutMs, operation)
  try {
    const payload = asRecord(JSON.parse(text) as unknown)
    if (!payload) throw new Error('not an object')
    return payload
  } catch {
    throw new AcceptanceError(operation + ' returned invalid JSON', operation)
  }
}

async function runPreviewSocket(origin: string, path: string, jar: CookieJar, timeoutMs: number): Promise<void> {
  const url = new URL(origin)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = path
  url.search = ''
  url.hash = ''
  const socket = openWebSocket(url.toString(), {
    headers: { Cookie: jar.header(), Origin: origin },
  })
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false
    const timeout = setTimeout(() => {
      finish(new AcceptanceError('preview WebSocket marker was not observed before timeout', 'preview'))
    }, timeoutMs)
    const finish = (error?: AcceptanceError) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try {
        socket.close(1000, 'acceptance complete')
      } catch {
        // The socket may already be closed.
      }
      if (error) rejectPromise(error)
      else resolvePromise()
    }
    socket.addEventListener('open', () => {
      try {
        socket.send('TENGRI_PREVIEW_WS_PROBE')
      } catch {
        finish(new AcceptanceError('preview WebSocket input could not be sent', 'preview'))
      }
    })
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string' && event.data.includes('TENGRI_PREVIEW_WS_OK:TENGRI_PREVIEW_WS_PROBE')) {
        finish()
      }
    })
    socket.addEventListener('error', () => {
      finish(new AcceptanceError('preview WebSocket failed', 'preview'))
    })
    socket.addEventListener('close', () => {
      if (!settled) finish(new AcceptanceError('preview WebSocket closed before its marker', 'preview'))
    })
  })
}

async function runPreviewCheck(state: ExecutionState): Promise<void> {
  const terminalId = state.terminalId
  const agentId = state.agent?.id
  if (!terminalId || !agentId) throw new AcceptanceError('Preview requires an owned terminal', 'preview')
  const leaseId = state.lease?.leaseId ?? ''
  const numericPort = 43_000 + (Number.parseInt(leaseId.slice(0, 4), 16) % 1_000)
  const previewReadyMarker = probeMarker('TENGRI_PREVIEW_READY')
  const previewReadySplit = Math.ceil(previewReadyMarker.length / 2)
  const previewReadyLeft = previewReadyMarker.slice(0, previewReadySplit)
  const previewReadyRight = previewReadyMarker.slice(previewReadySplit)
  const serverCommand = `bun -e 'const server = Bun.serve({ port: ${numericPort}, fetch(request, server) { if (server.upgrade(request)) return; return new Response("TENGRI_PREVIEW_HTTP_OK"); }, websocket: { message(socket, message) { socket.send("TENGRI_PREVIEW_WS_OK:" + String(message)); } } }); console.log("${previewReadyLeft}" + "${previewReadyRight}");'\n`
  await runTerminalCommand(
    state.primary,
    agentId,
    terminalId,
    serverCommand,
    previewReadyMarker,
    state.options.timeoutMs,
  )
  const preview = parsePreviewAction(
    await state.primary.action(
      { action: 'preview-session', agentId, port: numericPort, path: '/', fragment: '' },
      'issue preview session',
    ),
    'issue preview session',
  )
  const expectedOrigin = previewOriginForSession(preview.previewOrigin, preview.id, 'preview')
  state.previewSessionIds.push(preview.id)
  if (state.lease && !state.lease.previewSessionIds.includes(preview.id)) {
    state.lease.previewSessionIds.push(preview.id)
    updateLease(state.options.leaseFile, state.lease)
  }
  const launch = previewTokenFromHash(preview.launchUrl, 'preview')
  if (launch.url.pathname !== '/v1/preview/open' || launch.url.origin !== state.previewGatewayOrigin) {
    throw new AcceptanceError('Preview launch ticket is bound to an unexpected gateway', 'preview')
  }
  const openResponse = await externalRequest(
    state,
    launch.url.toString(),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: state.previewGatewayOrigin },
      body: JSON.stringify({ token: launch.token }),
    },
    new CookieJar(),
    'open preview',
  )
  if (!openResponse.ok) throw new HttpFailure('open preview', openResponse.status)
  const openPayload = await parseExternalJson(openResponse, 'open preview', state.options.timeoutMs)
  const location = requiredString(openPayload.location, 'preview location', 'preview')
  const target = previewTokenFromHash(location, 'preview')
  if (target.url.origin !== expectedOrigin)
    throw new AcceptanceError('Preview location origin is not session scoped', 'preview')
  const bootstrapDocument = await externalRequest(
    state,
    target.url.toString(),
    { method: 'GET', headers: { Accept: 'text/html', Origin: expectedOrigin } },
    new CookieJar(),
    'preview bootstrap document',
  )
  if (!bootstrapDocument.ok) throw new HttpFailure('preview bootstrap document', bootstrapDocument.status)
  const document = await readBodyText(
    bootstrapDocument,
    MAX_PREVIEW_BODY_BYTES,
    state.options.timeoutMs,
    'preview bootstrap document',
  )
  if (!document.includes('/_tengri/bootstrap.js')) {
    throw new AcceptanceError('Preview origin did not return its bootstrap document', 'preview')
  }
  const previewCookies = new CookieJar()
  const bootstrapResponse = await externalRequest(
    state,
    expectedOrigin + '/_tengri/bootstrap',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: expectedOrigin },
      body: JSON.stringify({ token: target.token }),
    },
    previewCookies,
    'preview bootstrap',
  )
  if (!bootstrapResponse.ok) throw new HttpFailure('preview bootstrap', bootstrapResponse.status)
  const bootstrap = await parseExternalJson(bootstrapResponse, 'preview bootstrap', state.options.timeoutMs)
  if (typeof bootstrap.fragment !== 'string' || !previewCookies.has('__Host-tengri_preview')) {
    throw new AcceptanceError('Preview bootstrap did not establish its host-only session cookie', 'preview')
  }
  const guestResponse = await externalRequest(
    state,
    expectedOrigin + '/',
    { method: 'GET', headers: { Accept: 'text/plain', Origin: expectedOrigin } },
    previewCookies,
    'preview HTTP',
  )
  if (!guestResponse.ok) throw new HttpFailure('preview HTTP', guestResponse.status)
  const guestBody = await readBodyText(guestResponse, MAX_PREVIEW_BODY_BYTES, state.options.timeoutMs, 'preview HTTP')
  if (!guestBody.includes('TENGRI_PREVIEW_HTTP_OK')) {
    throw new AcceptanceError('Preview HTTP did not reach the guest server', 'preview')
  }
  await runPreviewSocket(expectedOrigin, '/', previewCookies, state.options.timeoutMs)
  await state.primary.action(
    { action: 'revoke-preview-session', agentId, sessionId: preview.id },
    'revoke preview session',
  )
  state.previewSessionIds = state.previewSessionIds.filter((id) => id !== preview.id)
  if (state.lease) {
    state.lease.previewSessionIds = state.lease.previewSessionIds.filter((id) => id !== preview.id)
    updateLease(state.options.leaseFile, state.lease)
  }
  const revoked = await externalRequest(
    state,
    expectedOrigin + '/',
    { method: 'GET', headers: { Accept: 'text/plain', Origin: expectedOrigin } },
    previewCookies,
    'revoked preview',
  )
  if (revoked.status !== 401) throw new AcceptanceError('Revoked preview session remained accessible', 'preview')
  state.evidence.canary = {
    ...(state.evidence.canary ?? {
      agentId,
      displayName: state.agent?.displayName ?? '',
      image: state.runtime?.image ?? '',
    }),
    preview: { sessionId: preview.id, origin: expectedOrigin },
  }
}

async function runOwnerBoundaryCheck(state: ExecutionState): Promise<void> {
  const agentId = state.agent?.id
  const filePath = state.filePath
  if (!agentId || !filePath)
    throw new AcceptanceError('Owner boundary requires the owned acceptance file', 'ownerBoundary')
  const snapshot = await requireAuthenticatedSnapshot(state.rejection, 'rejection identity')
  if (snapshot.agents.some((agent) => agent.id === agentId)) {
    throw new AcceptanceError('Rejection identity can see the primary canary agent', 'ownerBoundary')
  }
  try {
    await state.rejection.action({ action: 'read-file', agentId, path: filePath }, 'owner rejection')
    throw new AcceptanceError('A second identity unexpectedly read the canary file', 'ownerBoundary')
  } catch (error) {
    if (!(error instanceof HttpFailure) || error.status !== 403) throw error
  }
}

async function runSleepResumeCheck(state: ExecutionState, expectedImage: string): Promise<void> {
  const agentId = state.agent?.id
  const before = state.runtime
  const filePath = state.filePath
  if (!agentId || !before || !filePath) throw new AcceptanceError('Sleep/resume requires a ready canary', 'sleepResume')
  await state.primary.action({ action: 'sleep-agent', agentId }, 'sleep agent')
  await waitForAgentPhase(state, 'sleeping')
  const sleeping = await waitFor(
    async () => {
      const mvm = await kubectlJson(
        state.runner,
        ['-n', 'tengri', 'get', 'microvm.runtime.proompteng.ai', agentId],
        'sleepResume',
      )
      const status = asRecord(mvm?.status)
      const pvcName = asString(status?.pvcName)
      if (asString(status?.phase) !== 'Sleeping' || pvcName !== before.pvcName) return undefined
      return { pvcName }
    },
    (value) => value.pvcName === before.pvcName,
    Math.min(state.options.timeoutMs, 120_000),
    state.options.pollIntervalMs,
    'sleeping canary runtime',
  )
  const sleepingPvc = await kubectlJson(state.runner, ['-n', 'tengri', 'get', 'pvc', sleeping.pvcName], 'sleepResume')
  const sleepingPvcUid = asString(asRecord(sleepingPvc?.metadata)?.uid)
  if (sleepingPvcUid !== before.pvcUid)
    throw new AcceptanceError('Sleep changed the persistent claim UID', 'sleepResume')
  await waitFor(
    () => kubectlJson(state.runner, ['-n', 'tengri', 'get', 'pod', before.podName], 'sleepResume', true),
    (pod) => pod === null,
    Math.min(state.options.timeoutMs, 120_000),
    state.options.pollIntervalMs,
    'sleeping canary Pod removal',
  )
  await state.primary.action({ action: 'resume-agent', agentId }, 'resume agent')
  await waitForAgentPhase(state, 'ready')
  const resumed = await inspectReadyRuntime(state, expectedImage)
  if (resumed.pvcUid !== before.pvcUid || resumed.podUid === before.podUid) {
    throw new AcceptanceError('Resume did not recreate the Pod on the retained claim', 'sleepResume')
  }
  const persisted = await readOwnedFile(state, filePath)
  if (!persisted || !state.fileContentSha256 || sha256Hex(persisted.content) !== state.fileContentSha256) {
    throw new AcceptanceError('Workspace content did not persist across sleep/resume', 'sleepResume')
  }
  state.runtime = resumed
  state.evidence.canary = {
    ...(state.evidence.canary ?? {
      agentId,
      displayName: state.agent?.displayName ?? '',
      image: expectedImage,
    }),
    podImageDigest: resumed.podImageDigest,
    pvcUid: before.pvcUid,
    initialPodUid: before.podUid,
    resumedPodUid: resumed.podUid,
  }
}

async function runCodexAccountCheck(state: ExecutionState): Promise<void> {
  const agentId = state.agent?.id
  if (!agentId) throw new AcceptanceError('Codex account check requires a canary', 'codexAccount')
  try {
    const result = asRecord(await state.primary.action({ action: 'codex-account', agentId }, 'Codex account check'))
    if (result?.authenticated === true) {
      state.evidence.codexAccount = { status: 'authenticated' }
      setCheck(state.evidence, 'codexAccount', 'passed')
    } else {
      state.evidence.codexAccount = {
        status: 'not_authenticated',
        detail: 'No Codex account session was available in the guest',
      }
      setCheck(state.evidence, 'codexAccount', 'not_configured', 'Codex account was not authenticated')
    }
  } catch (error) {
    if (error instanceof HttpFailure && error.status !== undefined && [401, 403, 404, 503].includes(error.status)) {
      state.evidence.codexAccount = { status: 'unavailable', detail: 'Codex account endpoint is unavailable' }
      setCheck(state.evidence, 'codexAccount', 'not_configured', 'Codex account endpoint unavailable')
      return
    }
    throw error
  }
}

export async function cleanupState(state: ExecutionState): Promise<AcceptanceError | undefined> {
  state.activeCheck = 'cleanup'
  if (!state.lease || !state.agent) {
    state.evidence.cleanup = {
      status: 'not_attempted',
      detail: 'No durable canary lease was available; no resource was selected for cleanup',
    }
    setCheck(state.evidence, 'cleanup', 'not_run')
    return undefined
  }
  const lease = state.lease
  const errors: string[] = []
  try {
    await verifyLeaseIncarnation(state)
    await verifyOwnedFileBeforeCleanup(state)
  } catch (error) {
    const failure =
      error instanceof AcceptanceError
        ? error
        : new AcceptanceError('Cleanup safety preflight failed; canary was retained', 'cleanup')
    state.evidence.cleanup = { status: 'failed', detail: safeErrorMessage(failure) }
    setCheck(state.evidence, 'cleanup', 'failed', 'Cleanup stopped before mutation; canary was retained')
    return failure
  }
  for (const sessionId of [...state.previewSessionIds, ...lease.previewSessionIds].reverse()) {
    if (!PREVIEW_SESSION_ID.test(sessionId)) continue
    try {
      await state.primary.action(
        { action: 'revoke-preview-session', agentId: lease.agentId, sessionId },
        'cleanup preview session',
      )
    } catch (error) {
      if (!(error instanceof HttpFailure && error.status === 404)) errors.push('preview session cleanup failed')
    }
  }
  const terminalId = state.terminalId ?? lease.terminalId
  if (terminalId) {
    try {
      await state.primary.action(
        { action: 'terminate-terminal', agentId: lease.agentId, terminalId },
        'cleanup terminal',
      )
    } catch (error) {
      if (!(error instanceof HttpFailure && error.status === 404)) errors.push('terminal cleanup failed')
    }
  }
  const filePath = state.filePath ?? lease.filePath
  const expectedFileSha = state.fileContentSha256 ?? lease.fileContentSha256
  if (state.fileOwned && filePath && expectedFileSha) {
    try {
      const current = await readOwnedFile(state, filePath)
      if (current && sha256Hex(current.content) === expectedFileSha) {
        await state.primary.action(
          { action: 'delete-file', agentId: lease.agentId, path: filePath, recursive: false },
          'cleanup acceptance file',
        )
      } else {
        const failure = new AcceptanceError('Acceptance file changed during cleanup; canary was retained', 'safety')
        state.evidence.cleanup = { status: 'failed', detail: safeErrorMessage(failure) }
        setCheck(state.evidence, 'cleanup', 'failed', 'Cleanup stopped before agent deletion; canary was retained')
        return failure
      }
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 404) {
        const failure = new AcceptanceError('Acceptance file disappeared during cleanup; canary was retained', 'safety')
        state.evidence.cleanup = { status: 'failed', detail: safeErrorMessage(failure) }
        setCheck(state.evidence, 'cleanup', 'failed', 'Cleanup stopped before agent deletion; canary was retained')
        return failure
      }
      const failure = new AcceptanceError(
        'Acceptance file could not be verified during cleanup; canary was retained',
        'safety',
      )
      state.evidence.cleanup = { status: 'failed', detail: safeErrorMessage(failure) }
      setCheck(state.evidence, 'cleanup', 'failed', 'Cleanup stopped before agent deletion; canary was retained')
      return failure
    }
  }
  try {
    await verifyLeaseIncarnation(state)
  } catch (error) {
    const failure =
      error instanceof AcceptanceError
        ? error
        : new AcceptanceError('Cleanup safety recheck failed; canary was retained', 'cleanup')
    state.evidence.cleanup = { status: 'failed', detail: safeErrorMessage(failure) }
    setCheck(state.evidence, 'cleanup', 'failed', 'Cleanup stopped before agent deletion; canary was retained')
    return failure
  }
  try {
    await state.primary.action({ action: 'delete-agent', agentId: lease.agentId }, 'delete acceptance agent')
  } catch (error) {
    if (!(error instanceof HttpFailure && error.status === 404)) errors.push('acceptance agent deletion failed')
  }
  try {
    await waitFor(
      async () => {
        const snapshot = await state.primary.snapshot()
        return snapshot.agents.some((agent) => agent.id === lease.agentId) ? undefined : true
      },
      (value) => value === true,
      Math.min(state.options.timeoutMs, 120_000),
      state.options.pollIntervalMs,
      'acceptance agent deletion',
    )
  } catch {
    errors.push('acceptance agent remained visible after deletion')
  }
  const resourceNames = new Set<string>()
  resourceNames.add('microvm.runtime.proompteng.ai/' + lease.agentId)
  resourceNames.add('pod/' + (state.runtime?.podName || lease.agentId))
  resourceNames.add('pvc/' + (state.runtime?.pvcName || lease.agentId + '-home'))
  for (const resource of resourceNames) {
    const separator = resource.indexOf('/')
    const kind = resource.slice(0, separator)
    const name = resource.slice(separator + 1)
    try {
      await waitFor(
        () => kubectlJson(state.runner, ['-n', 'tengri', 'get', kind, name], 'cleanup', true),
        (value) => value === null,
        Math.min(state.options.timeoutMs, 120_000),
        state.options.pollIntervalMs,
        'cleanup ' + kind,
      )
    } catch {
      errors.push(kind + ' cleanup failed')
    }
  }
  if (state.baselineWorkloads) {
    try {
      const after = await listWorkloadImages(state.runner)
      assertWorkloadImagesRestored(state.baselineWorkloads, after)
      state.evidence.canary = {
        ...(state.evidence.canary ?? {
          agentId: lease.agentId,
          displayName: lease.displayName,
          image: state.runtime?.image ?? '',
        }),
        workloadsAfter: { count: after.count, fingerprint: after.fingerprint },
      }
    } catch {
      errors.push('existing workload image preservation could not be confirmed')
    }
  }
  if (errors.length === 0) {
    try {
      unlinkSync(state.options.leaseFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push('acceptance lease cleanup failed')
    }
  }
  if (errors.length > 0) {
    const failure = new AcceptanceError('cleanup did not remove every owned canary resource', 'cleanup')
    state.evidence.cleanup = { status: 'failed', detail: errors.join('; ') }
    setCheck(state.evidence, 'cleanup', 'failed', 'Owned canary cleanup was incomplete')
    return failure
  }
  state.evidence.cleanup = { status: 'passed' }
  setCheck(state.evidence, 'cleanup', 'passed')
  return undefined
}

function expectedImage(provenance: StageProvenance, key: 'tengri' | 'nanoagent' | 'proompteng'): string {
  const digest = provenance.digests[key]
  if (!digest) throw new AcceptanceError('Promoted image digest is missing', 'provenance')
  const repository = key === 'tengri' ? TENGRI_IMAGE : key === 'nanoagent' ? NANOAGENT_IMAGE : PROOMPTENG_IMAGE
  return repository + '@' + digest
}

function assertProvenanceStable(before: StageProvenance, after: StageProvenance): void {
  if (
    before.branchRevision !== after.branchRevision ||
    before.sourceRevision !== after.sourceRevision ||
    before.freightName !== after.freightName ||
    before.digests.tengri !== after.digests.tengri ||
    before.digests.nanoagent !== after.digests.nanoagent ||
    before.digests.proompteng !== after.digests.proompteng ||
    before.manifestDigests.tengri !== after.manifestDigests.tengri ||
    before.manifestDigests.nanoagent !== after.manifestDigests.nanoagent ||
    before.manifestDigests.proompteng !== after.manifestDigests.proompteng
  ) {
    throw new AcceptanceError('Kargo ' + before.stage + ' provenance changed during acceptance', 'provenance')
  }
}

export async function executeAcceptance(
  options: AcceptanceOptions,
  dependencies: Dependencies = {},
): Promise<Evidence> {
  const runner = dependencies.commandRunner ?? defaultCommandRunner
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const evidence = newEvidence(options)
  const state: ExecutionState = {
    options,
    runner,
    fetchImpl,
    primary: new BffClient(options, fetchImpl),
    rejection: new BffClient(
      {
        baseUrl: options.baseUrl,
        origin: options.origin,
        authCookie: options.rejectionAuthCookie,
        timeoutMs: options.timeoutMs,
      },
      fetchImpl,
    ),
    evidence,
    leaseDurable: false,
    fileOwned: false,
    previewSessionIds: [],
    previewGatewayOrigin: '',
    activeCheck: 'configuration',
  }
  let failure: AcceptanceError | undefined
  try {
    setCheck(evidence, 'configuration', 'passed')
    preflightPersistence(options)
    checkpointEvidence(evidence, options.outputPath)
    state.creationLeaseStore =
      dependencies.creationLeaseStore ??
      (process.env.GITHUB_ACTIONS === 'true' ? githubCreationLeaseStore(process.env) : undefined)
    await preflightKubernetesReads(runner)
    state.activeCheck = 'provenance'
    const tengri = await resolveStageProvenanceWhenReady(
      'tengri',
      options.stage === 'tengri' ? options.expectedRevision : undefined,
      runner,
      options.timeoutMs,
      options.pollIntervalMs,
    )
    const proompteng = await resolveStageProvenanceWhenReady(
      'proompteng',
      options.stage === 'proompteng' ? options.expectedRevision : undefined,
      runner,
      options.timeoutMs,
      options.pollIntervalMs,
    )
    evidence.provenance = { tengri, proompteng }
    setCheck(evidence, 'provenance', 'passed')
    checkpointEvidence(evidence, options.outputPath)
    state.activeCheck = 'delivery'
    const tengriDelivery = await verifyDeliveryWhenReady(
      tengri,
      'tengri',
      'tengri',
      'tengri',
      expectedImage(tengri, 'tengri'),
      runner,
      options.timeoutMs,
      options.pollIntervalMs,
    )
    const proomptengDelivery = await verifyDeliveryWhenReady(
      proompteng,
      'proompteng',
      'proompteng',
      'proompteng',
      expectedImage(proompteng, 'proompteng'),
      runner,
      options.timeoutMs,
      options.pollIntervalMs,
    )
    evidence.delivery = { tengri: tengriDelivery, proompteng: proomptengDelivery }
    setCheck(evidence, 'delivery', 'passed')
    checkpointEvidence(evidence, options.outputPath)
    state.activeCheck = 'authentication'
    let primarySnapshot = await requireAuthenticatedSnapshot(state.primary, 'primary identity')
    state.previewGatewayOrigin = new URL(primarySnapshot.previewGatewayOrigin).origin
    if (state.previewGatewayOrigin !== DESKTOP_ORIGIN.replace('proompteng.ai', 'tengri.proompteng.ai')) {
      throw new AcceptanceError('BFF returned an unexpected preview gateway origin', 'authentication')
    }
    const rejectionSnapshot = await requireAuthenticatedSnapshot(state.rejection, 'rejection identity')
    if (!primarySnapshot.userId || !rejectionSnapshot.userId || primarySnapshot.userId === rejectionSnapshot.userId) {
      throw new AcceptanceError(
        'Primary and rejection cookies must belong to two distinct authenticated identities',
        'authentication',
      )
    }
    setCheck(evidence, 'authentication', 'passed')
    checkpointEvidence(evidence, options.outputPath)
    state.activeCheck = 'recovery'
    primarySnapshot = await recoverInterruptedCanary(state, primarySnapshot)
    state.activeCheck = 'runtime'
    const inventoryBeforeCanary = await listWorkloadImages(runner)
    const agent = await ensureCanaryLease(state, primarySnapshot)
    checkpointEvidence(evidence, options.outputPath)
    const baseline = withoutWorkloadImage(inventoryBeforeCanary, agent.id)
    state.baselineWorkloads = baseline
    const nanoagentImage = expectedImage(tengri, 'nanoagent')
    state.runtime = await inspectReadyRuntime(state, nanoagentImage)
    evidence.canary = {
      agentId: agent.id,
      displayName: agent.displayName,
      microvmUid: state.runtime.microvmUid,
      image: nanoagentImage,
      podImageDigest: state.runtime.podImageDigest,
      pvcUid: state.runtime.pvcUid,
      initialPodUid: state.runtime.podUid,
      workloadsBefore: { count: baseline.count, fingerprint: baseline.fingerprint },
    }
    setCheck(evidence, 'runtime', 'passed')
    checkpointEvidence(evidence, options.outputPath)
    state.activeCheck = 'fileCas'
    await runFileCas(state)
    setCheck(evidence, 'fileCas', 'passed')
    checkpointEvidence(evidence, options.outputPath)
    state.activeCheck = 'ownerBoundary'
    await runOwnerBoundaryCheck(state)
    setCheck(evidence, 'ownerBoundary', 'passed')
    checkpointEvidence(evidence, options.outputPath)
    state.activeCheck = 'pty'
    await runPtyCheck(state)
    setCheck(evidence, 'pty', 'passed')
    checkpointEvidence(evidence, options.outputPath)
    state.activeCheck = 'preview'
    await runPreviewCheck(state)
    setCheck(evidence, 'preview', 'passed')
    checkpointEvidence(evidence, options.outputPath)
    state.activeCheck = 'sleepResume'
    await runSleepResumeCheck(state, nanoagentImage)
    setCheck(evidence, 'sleepResume', 'passed')
    checkpointEvidence(evidence, options.outputPath)
    state.activeCheck = 'codexAccount'
    await runCodexAccountCheck(state)
    checkpointEvidence(evidence, options.outputPath)
    state.activeCheck = 'provenance'
    const finalTengri = await resolveStageProvenanceWhenReady(
      'tengri',
      undefined,
      runner,
      options.timeoutMs,
      options.pollIntervalMs,
    )
    const finalProompteng = await resolveStageProvenanceWhenReady(
      'proompteng',
      undefined,
      runner,
      options.timeoutMs,
      options.pollIntervalMs,
    )
    assertProvenanceStable(tengri, finalTengri)
    assertProvenanceStable(proompteng, finalProompteng)
    state.activeCheck = 'delivery'
    const finalTengriDelivery = await verifyDeliveryWhenReady(
      finalTengri,
      'tengri',
      'tengri',
      'tengri',
      expectedImage(finalTengri, 'tengri'),
      runner,
      options.timeoutMs,
      options.pollIntervalMs,
    )
    const finalProomptengDelivery = await verifyDeliveryWhenReady(
      finalProompteng,
      'proompteng',
      'proompteng',
      'proompteng',
      expectedImage(finalProompteng, 'proompteng'),
      runner,
      options.timeoutMs,
      options.pollIntervalMs,
    )
    evidence.provenance = { tengri: finalTengri, proompteng: finalProompteng }
    evidence.delivery = { tengri: finalTengriDelivery, proompteng: finalProomptengDelivery }
    evidence.status = 'passed'
    evidence.acceptance = 'core_passed'
  } catch (error) {
    failure =
      error instanceof AcceptanceError
        ? error
        : new AcceptanceError('acceptance failed unexpectedly', state.activeCheck)
    evidence.status = 'failed'
    evidence.acceptance = 'failed'
    evidence.failedCheck = state.activeCheck
    evidence.error = safeErrorMessage(failure)
    setCheck(evidence, state.activeCheck, 'failed', evidence.error)
  } finally {
    const cleanupFailure = await cleanupState(state)
    if (cleanupFailure) {
      failure ??= cleanupFailure
      evidence.status = 'failed'
      evidence.acceptance = 'failed'
      evidence.failedCheck ??= 'cleanup'
      evidence.error = evidence.error ? evidence.error + '; cleanup did not complete' : safeErrorMessage(cleanupFailure)
    }
    evidence.finishedAt = new Date().toISOString()
    try {
      persistEvidence(evidence, options.outputPath)
    } catch {
      failure ??= new AcceptanceError('could not write acceptance evidence', 'evidence')
    }
  }
  if (failure) throw failure
  return evidence
}

function printUsage(): void {
  console.log(
    'Usage: bun run packages/scripts/src/tengri/acceptance.ts --stage <tengri|proompteng> --expected-revision <sha40> [options]\n\n' +
      'Required environment: TENGRI_AUTH_COOKIE and TENGRI_REJECTION_AUTH_COOKIE, each from a different dedicated GitHub identity.\n' +
      'Options: --base-url <origin> --run-id <id> --lease-file <path> --output <path> --timeout-seconds <n> --poll-interval-seconds <n>',
  )
}

function fallbackArgument(argv: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === flag) return argv[index + 1]
    if (argument.startsWith(flag + '=')) return argument.slice(flag.length + 1)
  }
  return undefined
}

function fallbackEvidence(error: unknown, env: NodeJS.ProcessEnv, argv: readonly string[] = []): void {
  const output = env.TENGRI_ACCEPTANCE_OUTPUT
  if (!output) return
  const stageValue = fallbackArgument(argv, '--stage') ?? env.TENGRI_ACCEPTANCE_STAGE
  const stage: StageName = stageValue === 'proompteng' ? 'proompteng' : 'tengri'
  const revisionValue = fallbackArgument(argv, '--expected-revision') ?? env.TENGRI_ACCEPTANCE_EXPECTED_REVISION
  const evidence = newEvidence({
    baseUrl: DESKTOP_ORIGIN,
    origin: DESKTOP_ORIGIN,
    stage,
    expectedRevision:
      revisionValue && SHA40.test(revisionValue)
        ? revisionValue.toLowerCase()
        : env.GITHUB_SHA && SHA40.test(env.GITHUB_SHA)
          ? env.GITHUB_SHA.toLowerCase()
          : '',
    runId: 'configuration-failure',
    authCookie: '',
    rejectionAuthCookie: '',
    leaseFile: '',
    outputPath: output,
    timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1_000,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_SECONDS * 1_000,
    diagnostic: env.GITHUB_EVENT_NAME === 'workflow_dispatch',
  })
  evidence.status = 'failed'
  evidence.acceptance = 'incomplete'
  evidence.failedCheck = 'configuration'
  evidence.error = safeErrorMessage(error)
  setCheck(evidence, 'configuration', 'failed', evidence.error)
  try {
    persistEvidence(evidence, resolve(output))
  } catch {
    // The original configuration error remains the actionable failure.
  }
}

if (import.meta.main) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage()
  } else {
    let options: AcceptanceOptions | undefined
    try {
      options = parseAcceptanceArgs(process.argv.slice(2))
      const evidence = await executeAcceptance(options)
      console.log(
        JSON.stringify({
          status: evidence.status,
          acceptance: evidence.acceptance,
          stage: evidence.stage,
          output: options.outputPath,
          codexAccount: evidence.codexAccount.status,
        }),
      )
    } catch (error) {
      if (!options || !existsSync(options.outputPath)) fallbackEvidence(error, process.env, process.argv.slice(2))
      console.error('Tengri real-guest acceptance failed: ' + safeErrorMessage(error))
      process.exitCode = 1
    }
  }
}
