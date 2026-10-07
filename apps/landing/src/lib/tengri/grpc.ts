import 'server-only'

import type { TengriCodexImage } from './codex-images'

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import type {
  AgentArchitecture,
  AgentPhase,
  TengriAgent,
  TengriCodexAccount,
  TengriCodexEvent,
  TengriCodexEventKind,
  TengriCodexLogin,
  TengriCodexThread,
  TengriCodexTurn,
  TengriCondition,
  TengriErrorCode,
  TengriFileEntry,
  TengriFileEvent,
  TengriFileEventKind,
  TengriFileSearchResult,
  TengriPreviewSession,
  TengriTerminalSession,
  TengriTerminalTicket,
} from '@/lib/tengri/types'
import { parseTengriSigningSecrets, signTengriMetadata } from './internal-auth'
import { readTengriBffSecret } from './runtime-secrets'
import { parseCodexModelPage, type TengriCodexOptions } from './codex-models'
import { SpiffeSource, parseSpiffeId, verifySpiffePeer } from './spiffe'
import { tengriPowerSettingsSchema, type TengriPowerSettings } from './schemas'
import { codexHistoryResponse } from './codex-history-stream'
import type { CodexHistoryPage } from './codex-history'

const DEFAULT_GRPC_DEADLINE_MS = 15_000
const LIFECYCLE_GRPC_DEADLINE_MS = 310_000
const MAX_GRPC_MESSAGE_BYTES = 16 * 1024 * 1024
const PROTO_RELATIVE_PATH = 'proompteng/runtime/v1/microvm.proto'
const NO_PRESERVED_SCALAR_DEFAULTS = new Set<string>()
const WATCH_FILES_PRESERVED_SCALAR_DEFAULTS = new Set(['afterSequence'])
const POWER_SETTINGS_PRESERVED_SCALAR_DEFAULTS = new Set(['idleTimeoutMinutes'])

type RawRecord = Record<string, unknown>
type RawAgent = RawRecord & {
  id?: string
  displayName?: string
  phase?: string
  architecture?: string
  cpuMillis?: number
  memoryMib?: number
  workspaceGib?: number
  idleTimeoutMinutes?: number
  nodeName?: string
  message?: string
  createdAt?: string
  readyAt?: string
  lastActivityAt?: string
  idleDeadline?: string
  conditions?: RawRecord[]
}

type UnaryMethod = (
  request: RawRecord,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, response: unknown) => void,
) => grpc.ClientUnaryCall

type StreamMethod = (
  request: RawRecord,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
) => grpc.ClientReadableStream<RawRecord>

type TengriGrpcClient = grpc.Client & Record<string, UnaryMethod | StreamMethod>
type RuntimeMethodDefinition = {
  path: string
  originalName?: string
  requestSerialize: (request: RawRecord) => Buffer
}
type RuntimeServiceDefinition = Record<string, RuntimeMethodDefinition>
type RuntimeDescriptor = {
  proompteng: {
    runtime: {
      v1: {
        MicroVMControlPlane: grpc.ServiceClientConstructor & { service: RuntimeServiceDefinition }
      }
    }
  }
}

export class TengriUnavailableError extends Error {
  readonly status: number
  readonly code?: TengriErrorCode

  constructor(message: string, status = 503, code?: TengriErrorCode) {
    super(message)
    this.name = 'TengriUnavailableError'
    this.status = status
    this.code = code
  }
}

export function isTengriControlPlaneConfigured() {
  return Boolean(
    process.env.TENGRI_GRPC_ENDPOINT?.trim() &&
    signingSecrets() &&
    process.env.SPIFFE_ENDPOINT_SOCKET?.trim() &&
    process.env.SPIFFE_ID?.trim() &&
    process.env.TENGRI_SPIFFE_ID?.trim(),
  )
}

export async function listAgents(subject: string): Promise<TengriAgent[]> {
  const response = await unary<{ agents?: RawAgent[] }>('listAgents', {}, subject)
  return (response.agents ?? []).map(normalizeAgent)
}

export async function createAgent(subject: string, displayName: string) {
  return normalizeAgent(await unary<RawAgent>('createAgent', { displayName }, subject, LIFECYCLE_GRPC_DEADLINE_MS))
}

export async function getAgent(subject: string, id: string) {
  return normalizeAgent(await unary<RawAgent>('getAgent', { id }, subject))
}

export async function sleepAgent(subject: string, id: string) {
  return normalizeAgent(await unary<RawAgent>('sleepAgent', { id }, subject, LIFECYCLE_GRPC_DEADLINE_MS))
}

export async function resumeAgent(subject: string, id: string) {
  return normalizeAgent(await unary<RawAgent>('resumeAgent', { id }, subject, LIFECYCLE_GRPC_DEADLINE_MS))
}

export async function updatePowerSettings(subject: string, id: string, power: TengriPowerSettings) {
  return normalizeAgent(
    await unary<RawAgent>(
      'updatePowerSettings',
      {
        id,
        idleTimeoutMinutes: power.idleTimeoutMinutes,
      },
      subject,
      DEFAULT_GRPC_DEADLINE_MS,
      undefined,
      POWER_SETTINGS_PRESERVED_SCALAR_DEFAULTS,
    ),
  )
}

export async function deleteAgent(subject: string, id: string) {
  await unary('deleteAgent', { id }, subject)
}

export async function listFiles(subject: string, agentId: string, filePath: string) {
  const response = await unary<{ path?: string; entries?: RawRecord[] }>(
    'listFiles',
    { agentId, path: filePath },
    subject,
    130_000,
  )
  return { path: stringValue(response.path, '/'), entries: (response.entries ?? []).map(normalizeFileEntry) }
}

export async function readFile(subject: string, agentId: string, filePath: string) {
  const response = await unary<{ path?: string; content?: Uint8Array; contentType?: string; revision?: string }>(
    'readFile',
    { agentId, path: filePath },
    subject,
    130_000,
  )
  const content = response.content ?? new Uint8Array()
  const revision = stringValue(response.revision)
  if (revision && revision !== createHash('sha256').update(content).digest('hex')) {
    throw new TengriUnavailableError('The file revision could not be verified. Reopen the file before editing.')
  }
  return {
    path: stringValue(response.path, filePath),
    content: decodeUtf8File(content),
    contentType: stringValue(response.contentType, 'application/octet-stream'),
    revision,
  }
}

export async function writeFile(
  subject: string,
  agentId: string,
  filePath: string,
  content: string,
  expectedRevision: string,
  signal?: AbortSignal,
) {
  if (!/^(?:[a-f0-9]{64}|missing)$/.test(expectedRevision)) {
    throw new TengriUnavailableError('A base file revision is required before saving', 400)
  }
  const bytes = Buffer.from(content)
  const response = await unary<{ path?: string; size?: number; revision?: string }>(
    'writeFile',
    { agentId, path: filePath, content: bytes, expectedRevision },
    subject,
    130_000,
    signal,
  )
  if (response.revision !== createHash('sha256').update(bytes).digest('hex')) {
    throw new TengriUnavailableError('The save could not be confirmed. Reopen the file to check its contents.')
  }
  return { path: stringValue(response.path, filePath), size: numberValue(response.size), revision: response.revision }
}

export async function createDirectory(subject: string, agentId: string, filePath: string) {
  return normalizeFileEntry(await unary<RawRecord>('createDirectory', { agentId, path: filePath }, subject, 130_000))
}

export async function moveFile(subject: string, agentId: string, sourcePath: string, destinationPath: string) {
  return normalizeFileEntry(
    await unary<RawRecord>('moveFile', { agentId, sourcePath, destinationPath }, subject, 130_000),
  )
}

export async function deleteFile(subject: string, agentId: string, filePath: string, recursive: boolean) {
  await unary('deleteFile', { agentId, path: filePath, recursive }, subject, 130_000)
}

export async function searchFiles(subject: string, agentId: string, filePath: string, query: string) {
  const response = await unary<{ entries?: RawRecord[]; truncated?: boolean }>(
    'searchFiles',
    { agentId, path: filePath, query, limit: 100 },
    subject,
    130_000,
  )
  return {
    entries: (response.entries ?? []).map(normalizeFileEntry),
    truncated: response.truncated === true,
  } satisfies TengriFileSearchResult
}

export async function watchFiles(subject: string, agentId: string, filePath: string, afterSequence?: number) {
  const request: RawRecord = { agentId, path: filePath }
  if (afterSequence !== undefined) request.afterSequence = afterSequence
  return stream('watchFiles', request, subject, WATCH_FILES_PRESERVED_SCALAR_DEFAULTS)
}

export function normalizeFileEvent(event: RawRecord): TengriFileEvent {
  const entry = event.entry && typeof event.entry === 'object' ? normalizeFileEntry(event.entry as RawRecord) : null
  return {
    sequence: numberValue(event.sequence),
    kind: normalizeFileEventKind(stringValue(event.kind)),
    path: stringValue(event.path),
    previousPath: stringValue(event.previousPath),
    entry,
  }
}

export async function listTerminals(subject: string, agentId: string) {
  const response = await unary<{ sessions?: RawRecord[] }>('listTerminals', { agentId }, subject, 130_000)
  return (response.sessions ?? []).map(normalizeTerminal)
}

export async function createTerminal(
  subject: string,
  agentId: string,
  creationId: string,
  cwd: string,
  columns: number,
  rows: number,
  signal?: AbortSignal,
) {
  return normalizeTerminal(
    await unary<RawRecord>('createTerminal', { agentId, creationId, cwd, columns, rows }, subject, 130_000, signal),
  )
}

export async function terminateTerminal(subject: string, agentId: string, terminalId: string) {
  await unary('terminateTerminal', { agentId, terminalId }, subject)
}

export async function issueTerminalTicket(
  subject: string,
  agentId: string,
  terminalId: string,
): Promise<TengriTerminalTicket> {
  const response = await unary<RawRecord>('issueTerminalTicket', { agentId, terminalId }, subject)
  return {
    websocketUrl: stringValue(response.websocketUrl),
    ticket: stringValue(response.ticket),
    expiresAt: stringValue(response.expiresAt),
  }
}

export async function getCodexAccount(
  subject: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<TengriCodexAccount> {
  const response = await unary<RawRecord>('getCodexAccount', { agentId }, subject, 130_000, signal)
  return {
    authenticated: Boolean(response.authenticated),
    email: stringValue(response.email),
    plan: stringValue(response.plan),
  }
}

export async function getCodexLogin(
  subject: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<TengriCodexLogin | null> {
  try {
    const response = await unary<RawRecord>('getCodexLogin', { agentId }, subject, 130_000, signal)
    return normalizeCodexLogin(response)
  } catch (error) {
    if (error instanceof TengriUnavailableError && error.status === 404) return null
    throw error
  }
}

export async function startCodexLogin(subject: string, agentId: string): Promise<TengriCodexLogin> {
  const response = await unary<RawRecord>('startCodexLogin', { agentId }, subject, 130_000)
  return normalizeCodexLogin(response)
}

function normalizeCodexLogin(response: RawRecord): TengriCodexLogin {
  return {
    loginId: stringValue(response.loginId),
    verificationUrl: stringValue(response.verificationUrl),
    userCode: stringValue(response.userCode),
    expiresAt: stringValue(response.expiresAt),
  }
}

export async function listCodexModels(subject: string, agentId: string, cursor?: string) {
  const response = await unary<RawRecord>('listCodexModels', { agentId, cursor }, subject, 130_000)
  try {
    return parseCodexModelPage(stringValue(response.rawJson))
  } catch {
    throw new TengriUnavailableError('The guest returned an invalid Codex model catalog')
  }
}

export async function createCodexThread(
  subject: string,
  agentId: string,
  options: TengriCodexOptions = {},
): Promise<TengriCodexThread> {
  const response = await unary<RawRecord>('createCodexThread', { agentId, ...options }, subject, 130_000)
  return normalizeCodexThread(response)
}

export async function resumeCodexThread(
  subject: string,
  agentId: string,
  threadId: string,
  options: TengriCodexOptions = {},
  signal: AbortSignal = new AbortController().signal,
) {
  const source = await stream(
    'resumeCodexThread',
    { agentId, threadId, ...options },
    subject,
    NO_PRESERVED_SCALAR_DEFAULTS,
    130_000,
  )
  return codexHistoryResponse(source, signal, normalizeCodexHistoryPage, (error) => {
    if (error instanceof TengriUnavailableError) return error
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number') {
      return mapGrpcError(error as grpc.ServiceError, 'resumeCodexThread')
    }
    return new TengriUnavailableError('Codex conversation recovery returned invalid history')
  })
}

function normalizeCodexHistoryPage(response: RawRecord): CodexHistoryPage {
  let part: CodexHistoryPage['part']
  switch (response.part) {
    case 'CODEX_HISTORY_PART_THREAD':
      part = 'thread'
      break
    case 'CODEX_HISTORY_PART_ITEMS':
      part = 'items'
      break
    case 'CODEX_HISTORY_PART_TURNS':
      part = 'turns'
      break
    default:
      throw new TengriUnavailableError('Codex conversation recovery returned invalid history')
  }
  if (typeof response.rawJson !== 'string' || !response.rawJson) {
    throw new TengriUnavailableError('Codex conversation recovery returned invalid history')
  }
  return { type: 'page', part, rawJson: response.rawJson, eventSequence: sequenceValue(response.eventSequence) }
}

function normalizeCodexThread(response: RawRecord): TengriCodexThread {
  const eventSequence = sequenceValue(response.eventSequence)
  const itemCursors: Array<[string, number]> = []
  if (response.itemEventSequences !== undefined && response.itemEventSequences !== null) {
    if (typeof response.itemEventSequences !== 'object' || Array.isArray(response.itemEventSequences)) {
      throw new TengriUnavailableError('Tengri control plane returned invalid Codex item cursors')
    }
    for (const [id, value] of Object.entries(response.itemEventSequences)) {
      const sequence = sequenceValue(value)
      if (sequence < eventSequence) {
        throw new TengriUnavailableError('Tengri control plane returned an outdated Codex item cursor')
      }
      itemCursors.push([id, sequence])
    }
  }
  return {
    id: stringValue(response.id),
    rawJson: stringValue(response.rawJson),
    eventSequence,
    itemEventSequences: Object.fromEntries(itemCursors),
  }
}

export async function sendCodexTurn(
  subject: string,
  agentId: string,
  threadId: string,
  text: string,
  options: TengriCodexOptions = {},
  images: readonly TengriCodexImage[] = [],
) {
  return normalizeTurn(
    await unary<RawRecord>(
      'sendCodexInput',
      {
        agentId,
        threadId,
        text,
        ...options,
        images: images.map((image) => ({ mediaType: image.mediaType, content: Buffer.from(image.data, 'base64') })),
      },
      subject,
      130_000,
    ),
  )
}

export async function steerCodexTurn(
  subject: string,
  agentId: string,
  threadId: string,
  turnId: string,
  text: string,
  images: readonly TengriCodexImage[] = [],
) {
  return normalizeTurn(
    await unary<RawRecord>(
      'steerCodexInput',
      {
        agentId,
        threadId,
        turnId,
        text,
        images: images.map((image) => ({ mediaType: image.mediaType, content: Buffer.from(image.data, 'base64') })),
      },
      subject,
      130_000,
    ),
  )
}

export async function interruptCodexTurn(subject: string, agentId: string, threadId: string, turnId: string) {
  await unary('interruptCodexTurn', { agentId, threadId, turnId }, subject)
}

export async function resolveCodexApproval(
  subject: string,
  agentId: string,
  approvalId: string,
  decision:
    | 'approve-once'
    | 'approve-session'
    | 'approve-exec-policy-amendment'
    | 'approve-network-policy-amendment'
    | 'deny',
) {
  const wireDecision = {
    'approve-once': 'CODEX_APPROVAL_DECISION_APPROVE_ONCE',
    'approve-session': 'CODEX_APPROVAL_DECISION_APPROVE_SESSION',
    'approve-exec-policy-amendment': 'CODEX_APPROVAL_DECISION_APPROVE_EXEC_POLICY_AMENDMENT',
    'approve-network-policy-amendment': 'CODEX_APPROVAL_DECISION_APPROVE_NETWORK_POLICY_AMENDMENT',
    deny: 'CODEX_APPROVAL_DECISION_DENY',
  }[decision]
  await unary('resolveCodexApproval', { agentId, approvalId, decision: wireDecision }, subject)
}

export async function issuePreviewSession(
  subject: string,
  agentId: string,
  port: number,
  path: string,
  fragment: string,
): Promise<TengriPreviewSession> {
  const response = await unary<RawRecord>('issuePreviewSession', { agentId, port, path, fragment }, subject, 130_000)
  return {
    id: stringValue(response.id),
    launchUrl: stringValue(response.launchUrl),
    expiresAt: stringValue(response.expiresAt),
    previewOrigin: stringValue(response.previewOrigin),
  }
}

export async function issueEditorSession(
  subject: string,
  agentId: string,
  windowId: string,
): Promise<TengriPreviewSession> {
  const response = await unary<RawRecord>('issueEditorSession', { agentId, windowId }, subject, 400_000)
  return {
    id: stringValue(response.id),
    launchUrl: stringValue(response.launchUrl),
    expiresAt: stringValue(response.expiresAt),
    previewOrigin: stringValue(response.previewOrigin),
  }
}

export async function revokeEditorSessions(subject: string) {
  await unary('revokeEditorSessions', {}, subject)
}

export async function revokePreviewSession(
  subject: string,
  agentId: string,
  sessionId: string,
  revocationToken?: string,
) {
  await unary('revokePreviewSession', { agentId, sessionId, revocationToken }, subject)
}

export async function watchCodexEvents(subject: string, agentId: string, afterSequence: number) {
  return stream('watchCodexEvents', { agentId, afterSequence }, subject)
}

export function normalizeCodexEvent(event: RawRecord): TengriCodexEvent {
  return {
    sequence: numberValue(event.sequence),
    kind: normalizeCodexEventKind(stringValue(event.kind)),
    method: stringValue(event.method),
    threadId: stringValue(event.threadId),
    turnId: stringValue(event.turnId),
    itemId: stringValue(event.itemId),
    text: stringValue(event.text),
    approvalId: stringValue(event.approvalId),
    rawJson: stringValue(event.rawJson),
  }
}

async function unary<Response = RawRecord>(
  methodName: string,
  request: RawRecord,
  subject: string,
  deadlineMs = DEFAULT_GRPC_DEADLINE_MS,
  signal?: AbortSignal,
  preservedScalarDefaults: ReadonlySet<string> = NO_PRESERVED_SCALAR_DEFAULTS,
): Promise<Response> {
  const client = await getClient()
  const method = client[methodName] as UnaryMethod
  if (typeof method !== 'function') throw new TengriUnavailableError(`Tengri method ${methodName} is unavailable`)
  const canonicalRequest = canonicalizeProto3Request(request, preservedScalarDefaults)
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedRequestError())
      return
    }
    let settled = false
    let call: grpc.ClientUnaryCall | null = null
    const onAbort = () => {
      if (settled) return
      settled = true
      call?.cancel()
      reject(abortedRequestError())
    }
    call = method.call(
      client,
      canonicalRequest,
      metadata(subject, methodName, canonicalRequest),
      callOptions(deadlineMs),
      (error, response) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(mapGrpcError(error, methodName))
        else resolve(response as Response)
      },
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function abortedRequestError() {
  const error = new Error('Tengri request was canceled')
  error.name = 'AbortError'
  return error
}

async function stream(
  methodName: string,
  request: RawRecord,
  subject: string,
  preservedScalarDefaults: ReadonlySet<string> = NO_PRESERVED_SCALAR_DEFAULTS,
  deadlineMs = 0,
) {
  const client = await getClient()
  const method = client[methodName] as StreamMethod
  if (typeof method !== 'function') throw new TengriUnavailableError(`Tengri method ${methodName} is unavailable`)
  const canonicalRequest = canonicalizeProto3Request(request, preservedScalarDefaults)
  return method.call(client, canonicalRequest, metadata(subject, methodName, canonicalRequest), callOptions(deadlineMs))
}

function canonicalizeProto3Request(
  request: RawRecord,
  preservedScalarDefaults: ReadonlySet<string> = NO_PRESERVED_SCALAR_DEFAULTS,
) {
  return Object.fromEntries(
    Object.entries(request).filter(([key, value]) => preservedScalarDefaults.has(key) || !isProto3ScalarDefault(value)),
  )
}

function isProto3ScalarDefault(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    value === false ||
    value === 0 ||
    (Array.isArray(value) && value.length === 0) ||
    (ArrayBuffer.isView(value) && value.byteLength === 0)
  )
}

async function getClient(): Promise<TengriGrpcClient> {
  const globalState = globalThis as typeof globalThis & {
    tengriGrpcClient?: TengriGrpcClient
    tengriGrpcService?: RuntimeServiceDefinition
    tengriSpiffeSource?: SpiffeSource
    tengriSpiffeConfiguration?: string
    tengriSpiffeFingerprint?: string
  }
  const target = process.env.TENGRI_GRPC_ENDPOINT?.trim()
  const endpoint = process.env.SPIFFE_ENDPOINT_SOCKET?.trim()
  const ownId = process.env.SPIFFE_ID?.trim()
  const peerId = process.env.TENGRI_SPIFFE_ID?.trim()
  if (!target || !endpoint || !ownId || !peerId || !signingSecrets()) {
    throw new TengriUnavailableError('Tengri workload identity is not configured')
  }
  parseSpiffeId(ownId)
  parseSpiffeId(peerId)
  const configuration = JSON.stringify([target, endpoint, ownId, peerId])
  if (!globalState.tengriSpiffeSource || globalState.tengriSpiffeConfiguration !== configuration) {
    globalState.tengriGrpcClient?.close()
    globalState.tengriGrpcClient = undefined
    globalState.tengriSpiffeSource?.close()
    globalState.tengriSpiffeSource = new SpiffeSource({
      endpoint,
      spiffeId: ownId,
      protoPath:
        process.env.SPIFFE_WORKLOAD_API_PROTO_PATH?.trim() ??
        path.resolve(path.dirname(resolveProtoPath()), '../../../spiffe/workloadapi.proto'),
    })
    globalState.tengriSpiffeConfiguration = configuration
  }
  let material
  try {
    material = await globalState.tengriSpiffeSource.material()
  } catch {
    throw new TengriUnavailableError('Tengri workload identity is unavailable')
  }
  if (globalState.tengriGrpcClient && globalState.tengriSpiffeFingerprint === material.fingerprint) {
    return globalState.tengriGrpcClient
  }
  const definition = protoLoader.loadSync(resolveProtoPath(), {
    defaults: true,
    enums: String,
    keepCase: false,
    longs: String,
    oneofs: true,
  })
  const descriptor = grpc.loadPackageDefinition(definition) as unknown as RuntimeDescriptor
  const Constructor = descriptor.proompteng.runtime.v1.MicroVMControlPlane
  const credentials = grpc.credentials.createSsl(material.bundle, material.privateKey, material.certificate, {
    checkServerIdentity: (_hostname, certificate) => verifySpiffePeer(peerId, certificate),
  })
  const client = new Constructor(target, credentials, {
    'grpc.max_receive_message_length': MAX_GRPC_MESSAGE_BYTES,
    'grpc.max_send_message_length': MAX_GRPC_MESSAGE_BYTES,
  }) as TengriGrpcClient
  const expiration = setTimeout(() => client.close(), Math.max(0, material.expiresAt - Date.now()))
  expiration.unref()
  globalState.tengriGrpcClient = client
  globalState.tengriGrpcService = Constructor.service
  globalState.tengriSpiffeFingerprint = material.fingerprint
  return client
}

function resolveProtoPath() {
  const candidates = [
    process.env.TENGRI_PROTO_PATH?.trim(),
    path.resolve(process.cwd(), 'proto', PROTO_RELATIVE_PATH),
    path.resolve(process.cwd(), '..', '..', 'services', 'tengri', 'proto', PROTO_RELATIVE_PATH),
  ].filter((candidate): candidate is string => Boolean(candidate))
  const existing = candidates.find(existsSync)
  if (!existing) throw new TengriUnavailableError('Tengri protocol definition is missing')
  return existing
}

function metadata(subject: string, methodName: string, request: RawRecord) {
  const secrets = signingSecrets()
  if (!secrets) throw new TengriUnavailableError('Tengri signing secret is not configured')
  const method = grpcMethod(methodName)
  let signed: ReturnType<typeof signTengriMetadata>
  try {
    signed = signTengriMetadata(subject, secrets, {
      rpcPath: method.path,
      body: method.requestSerialize(request),
    })
  } catch (cause) {
    throw new TengriUnavailableError(cause instanceof Error ? cause.message : 'Tengri signing failed', 503)
  }
  const value = new grpc.Metadata()
  value.set('x-tengri-subject', signed.subject)
  value.set('x-tengri-timestamp', signed.timestamp)
  value.set('x-tengri-nonce', signed.nonce)
  value.set('x-tengri-signature', signed.signature)
  if (signed.previousSignature) value.set('x-tengri-signature-previous', signed.previousSignature)
  return value
}

function grpcMethod(methodName: string) {
  const globalState = globalThis as typeof globalThis & { tengriGrpcService?: RuntimeServiceDefinition }
  const method = Object.values(globalState.tengriGrpcService ?? {}).find(
    (candidate) => candidate.originalName === methodName,
  )
  if (!method) throw new TengriUnavailableError(`Tengri method ${methodName} has no protocol definition`)
  return method
}

function signingSecrets() {
  return parseTengriSigningSecrets(readTengriBffSecret('TENGRI_INTERNAL_HMAC_SECRET'))
}

function callOptions(deadlineMs: number): grpc.CallOptions {
  return deadlineMs > 0 ? { deadline: Date.now() + deadlineMs } : {}
}

function mapGrpcError(error: grpc.ServiceError, methodName: string) {
  switch (error.code) {
    case grpc.status.UNIMPLEMENTED:
      if (methodName === 'listCodexModels') {
        return new TengriUnavailableError(
          'Model selection is unavailable for this workspace. Chat continues with existing Codex settings.',
          412,
          'model_selection_unavailable',
        )
      }
      return new TengriUnavailableError('Tengri control plane is unavailable', 503)
    case grpc.status.INVALID_ARGUMENT:
      return new TengriUnavailableError('Tengri request is invalid', 400)
    case grpc.status.UNAUTHENTICATED:
      return new TengriUnavailableError('Tengri control-plane authentication is unavailable', 503)
    case grpc.status.PERMISSION_DENIED:
      return new TengriUnavailableError('Tengri request is not permitted', 403)
    case grpc.status.NOT_FOUND:
      if (methodName === 'resumeCodexThread' && isMissingCodexConversation(error.details)) {
        return new TengriUnavailableError('Codex conversation could not be found', 404, 'conversation_not_found')
      }
      return new TengriUnavailableError('Tengri resource was not found', 404)
    case grpc.status.ALREADY_EXISTS:
      if (methodName === 'writeFile') {
        return new TengriUnavailableError(
          'File changed since it was opened. Review the changes before saving.',
          409,
          'file_conflict',
        )
      }
      return new TengriUnavailableError('Tengri resource already exists', 409)
    case grpc.status.FAILED_PRECONDITION:
      if (methodName === 'writeFile') {
        return new TengriUnavailableError(
          'This guest needs an update before saving. Sleep and resume the agent, then reopen the file.',
          412,
        )
      }
      return new TengriUnavailableError('Tengri request cannot be completed in the current state', 412)
    case grpc.status.RESOURCE_EXHAUSTED:
      if (methodName === 'createAgent') {
        return new TengriUnavailableError(
          'All six workspace slots are occupied. Existing workspaces are retained until their owners delete them. Try again when a slot becomes available.',
          429,
          'capacity_full',
        )
      }
      return new TengriUnavailableError('Tengri capacity is exhausted', 429)
    case grpc.status.DEADLINE_EXCEEDED:
      return new TengriUnavailableError('Tengri request timed out', 504)
    default:
      return new TengriUnavailableError('Tengri control plane is unavailable', 503)
  }
}

function isMissingCodexConversation(details: string) {
  try {
    const payload: unknown = JSON.parse(details)
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      payload.error === 'Codex conversation could not be found'
    )
  } catch {
    return false
  }
}

function decodeUtf8File(content: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content)
  } catch {
    throw new TengriUnavailableError('This file is not valid UTF-8 text', 415)
  }
}

function normalizeAgent(agent: RawAgent): TengriAgent {
  const power = tengriPowerSettingsSchema.safeParse({
    idleTimeoutMinutes: agent.idleTimeoutMinutes,
  })
  if (!power.success)
    throw new TengriUnavailableError('The runtime returned invalid power settings. Update Tengri and refresh.')
  return {
    id: stringValue(agent.id),
    displayName: stringValue(agent.displayName, 'Unnamed agent'),
    phase: normalizePhase(stringValue(agent.phase)),
    architecture: normalizeArchitecture(stringValue(agent.architecture)),
    cpuMillis: numberValue(agent.cpuMillis),
    memoryMib: numberValue(agent.memoryMib),
    workspaceGib: numberValue(agent.workspaceGib),
    power: power.data,
    nodeName: stringValue(agent.nodeName),
    message: stringValue(agent.message),
    createdAt: stringValue(agent.createdAt),
    readyAt: stringValue(agent.readyAt),
    lastActivityAt: stringValue(agent.lastActivityAt),
    idleDeadline: stringValue(agent.idleDeadline),
    conditions: (agent.conditions ?? []).map(normalizeCondition),
  }
}

function normalizeCondition(condition: RawRecord): TengriCondition {
  return {
    type: stringValue(condition.type),
    status: stringValue(condition.status),
    reason: stringValue(condition.reason),
    message: stringValue(condition.message),
    lastTransitionAt: stringValue(condition.lastTransitionAt),
  }
}

function normalizeFileEntry(entry: RawRecord): TengriFileEntry {
  return {
    name: stringValue(entry.name),
    path: stringValue(entry.path),
    directory: Boolean(entry.directory),
    size: numberValue(entry.size),
    modifiedAt: stringValue(entry.modifiedAt),
  }
}

function normalizeFileEventKind(value: string): TengriFileEventKind {
  return (
    ({
      FILE_EVENT_KIND_CREATED: 'created',
      FILE_EVENT_KIND_CHANGED: 'changed',
      FILE_EVENT_KIND_REMOVED: 'removed',
      FILE_EVENT_KIND_RENAMED: 'renamed',
      FILE_EVENT_KIND_RESET: 'reset',
    }[value] as TengriFileEventKind | undefined) ?? 'unknown'
  )
}

function normalizeTerminal(session: RawRecord): TengriTerminalSession {
  return {
    id: stringValue(session.id),
    creationId: stringValue(session.creationId),
    cwd: stringValue(session.cwd),
    createdAt: stringValue(session.createdAt),
    lastActivityAt: stringValue(session.lastActivityAt),
    attached: Boolean(session.attached),
  }
}

function normalizeTurn(turn: RawRecord): TengriCodexTurn {
  return { id: stringValue(turn.id), threadId: stringValue(turn.threadId) }
}

function normalizePhase(value: string): AgentPhase {
  return (
    ({
      AGENT_PHASE_PENDING: 'pending',
      AGENT_PHASE_BOOTING: 'booting',
      AGENT_PHASE_READY: 'ready',
      AGENT_PHASE_SLEEPING: 'sleeping',
      AGENT_PHASE_FAILED: 'failed',
      AGENT_PHASE_TERMINATING: 'terminating',
    }[value] as AgentPhase | undefined) ?? 'unknown'
  )
}

function normalizeArchitecture(value: string): AgentArchitecture {
  return (
    ({
      ARCHITECTURE_AMD64: 'amd64',
      ARCHITECTURE_ARM64: 'arm64',
    }[value] as AgentArchitecture | undefined) ?? 'unknown'
  )
}

function normalizeCodexEventKind(value: string): TengriCodexEventKind {
  return (
    ({
      CODEX_EVENT_KIND_THREAD_STATE: 'thread-state',
      CODEX_EVENT_KIND_ASSISTANT_TEXT: 'assistant-text',
      CODEX_EVENT_KIND_REASONING_SUMMARY: 'reasoning-summary',
      CODEX_EVENT_KIND_PLAN: 'plan',
      CODEX_EVENT_KIND_TOOL_CALL: 'tool-call',
      CODEX_EVENT_KIND_TOOL_OUTPUT: 'tool-output',
      CODEX_EVENT_KIND_FILE_DIFF: 'file-diff',
      CODEX_EVENT_KIND_APPROVAL: 'approval',
      CODEX_EVENT_KIND_USAGE: 'usage',
      CODEX_EVENT_KIND_USER_MESSAGE: 'user-message',
      CODEX_EVENT_KIND_WARNING: 'warning',
      CODEX_EVENT_KIND_ERROR: 'error',
    }[value] as TengriCodexEventKind | undefined) ?? 'unknown'
  )
}

function stringValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function numberValue(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function sequenceValue(value: unknown) {
  const sequence = Number(value)
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new TengriUnavailableError('Tengri control plane returned an invalid Codex event cursor')
  }
  return sequence
}
