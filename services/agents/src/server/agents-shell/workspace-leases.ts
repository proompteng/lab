import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { Buffer } from 'node:buffer'
import {
  chmodSync,
  chownSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lchownSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { writeAuditLog } from './audit'
import type { AuthContext } from './auth'
import type { AgentsShellConfig } from './config'
import { trustedExecutablePath, trustedPathValue } from './trusted-executables'
import { isInsidePath } from './workspace-policy'

const STATE_VERSION = 1
const MAX_TASK_SLUG_LENGTH = 48
const EXACT_GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const PERSISTED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PERSISTED_SESSION_HASH = /^[0-9a-f]{24}$/
const PERSISTED_GIT_REF = /^refs\/[!-~]+$/
const PERSISTED_LEASE_STATUSES = new Set<WorkspaceLeaseStatus>([
  'active',
  'expired',
  'orphaned',
  'quarantined',
  'released',
  'revoked',
])
const CONFINEMENT_FAILED_REASON_PREFIX = 'confinement_failed:'
const PUBLICATION_CHECK_FAILED_REASON = 'release_publication_check_failed'
const PRIVILEGED_GIT_TIMEOUT_MS = 120_000
const PRIVILEGED_GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024
const PRIVILEGED_GIT_NETWORK_SUBCOMMANDS = new Set(['fetch', 'ls-remote'])
const PRIVILEGED_GIT_EXECUTABLE_CONFIG_PATTERN =
  '^(core\\.(fsmonitor|alternaterefscommand|sshcommand|askpass|editor|pager)|sequence\\.editor|interactive\\.difffilter|gpg(\\.[^.]+)?\\.program|filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(command|textconv)|merge\\..*\\.driver|credential(\\..*)?\\.helper|difftool\\..*\\.cmd|mergetool\\..*\\.cmd|remote\\..*\\.(uploadpack|receivepack)|submodule\\..*\\.update)$'
const PRIVILEGED_GIT_INCLUDE_CONFIG_PATTERN = '^include(if\\..*)?\\.path$'
type PrivilegedGitConfigEntry = readonly [key: string, value: string]
const PRIVILEGED_GIT_BASE_ARGS = [
  '--no-pager',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.alternateRefsCommand=',
  '-c',
  'gpg.program=',
  '-c',
  'gpg.openpgp.program=',
  '-c',
  'gpg.x509.program=',
  '-c',
  'gpg.ssh.program=',
  '-c',
  'core.askPass=',
  '-c',
  'core.sshCommand=',
  '-c',
  'core.pager=',
  '-c',
  'credential.helper=',
  '-c',
  'credential.interactive=never',
  '-c',
  'diff.external=',
  '-c',
  'interactive.diffFilter=',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.file.allow=always',
  '-c',
  'protocol.https.allow=always',
  '-c',
  'protocol.http.allow=never',
  '-c',
  'protocol.ssh.allow=never',
  '-c',
  'protocol.git.allow=never',
  '-c',
  'protocol.ext.allow=never',
] as const

export type WorkspaceLeaseStatus = 'active' | 'expired' | 'orphaned' | 'quarantined' | 'released' | 'revoked'

export type WorkspaceLease = {
  leaseId: string
  sessionHash: string
  subject: string
  workspacePath: string
  branch: string
  head: string
  publicationHead: string
  publicationRefs: Record<string, string>
  device: number
  inode: number
  uid: number
  gid: number
  issuedAt: string
  renewedAt: string
  expiresAt: string
  status: WorkspaceLeaseStatus
  bootId: string
  activeJobIds: string[]
  reason: string | null
  created: boolean
}

type WorkspaceLeaseState = {
  version: number
  nextUid: number
  leases: WorkspaceLease[]
}

export type WorkspaceAcquireInput = {
  task: string
  baseRef?: string
  expectedCommit?: string
  existingPath?: string
}

export type ReadOnlyGitIndexScratch = {
  configPath: string
  hooksPath: string
  indexPath: string
  writableRoot: string
  cleanup: () => void
}

type WorkspaceLeaseManagerOptions = {
  uidAllocator?: () => number
  onLeaseInvalidated?: (lease: WorkspaceLease, reason: string) => void
}

type PrivilegedGitResult = {
  status: number
  stdout: string
  stderr: string
}

export const sessionIdentityHash = (sessionId: string) =>
  createHash('sha256').update(sessionId).digest('hex').slice(0, 24)

const safeTaskSlug = (task: string) => {
  const slug = task
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TASK_SLUG_LENGTH)
  if (!slug) throw new Error('task must contain at least one alphanumeric character')
  return slug
}

const iso = (timeMs: number) => new Date(timeMs).toISOString()

const parseTime = (value: string) => {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`invalid persisted lease timestamp: ${value}`)
  return parsed
}

const assertPositiveInteger = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

const persistedString = (record: Record<string, unknown>, key: string, label: string) => {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`invalid persisted ${label} ${key}`)
  return value
}

const persistedInteger = (record: Record<string, unknown>, key: string, label: string) => {
  const value = record[key]
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`invalid persisted ${label} ${key}`)
  }
  return value as number
}

const assertNoExistingSymlinkComponents = (root: string, candidate: string, label: string) => {
  const lexicalRoot = resolve(root)
  const lexicalCandidate = resolve(candidate)
  if (!isInsidePath(lexicalRoot, lexicalCandidate) && lexicalCandidate !== lexicalRoot) {
    throw new Error(`${label} must stay under the workspace root: ${lexicalCandidate}`)
  }
  let current = lexicalRoot
  const rootStat = lstatSync(current)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`workspace root must be a non-symlink directory: ${lexicalRoot}`)
  }
  const rel = relative(lexicalRoot, lexicalCandidate)
  if (!rel) return
  for (const component of rel.split(sep)) {
    current = join(current, component)
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} path must not contain symlinks: ${current}`)
    if (!stat.isDirectory() && current !== lexicalCandidate) {
      throw new Error(`${label} parent must be a directory: ${current}`)
    }
  }
}

const prepareServerDirectory = (workspaceRoot: string, path: string, mode: number, label: string) => {
  assertNoExistingSymlinkComponents(workspaceRoot, path, label)
  mkdirSync(path, { recursive: true, mode })
  assertNoSymlinkComponents(workspaceRoot, path)
  const canonicalRoot = realpathSync(workspaceRoot)
  const canonicalPath = realpathSync(path)
  if (!isInsidePath(canonicalRoot, canonicalPath) && canonicalPath !== canonicalRoot) {
    throw new Error(`${label} resolved outside the workspace root: ${canonicalPath}`)
  }
  let stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory: ${path}`)
  }
  const effectiveUid = process.geteuid?.() ?? stat.uid
  const effectiveGid = process.getegid?.() ?? stat.gid
  if (effectiveUid === 0 && (stat.uid !== 0 || stat.gid !== 0)) chownSync(path, 0, 0)
  else if (stat.uid !== effectiveUid || stat.gid !== effectiveGid) {
    throw new Error(`${label} must be owned by the agents-shell server: ${path}`)
  }
  if ((stat.mode & 0o777) !== mode) chmodSync(path, mode)
  stat = lstatSync(path)
  const expectedUid = effectiveUid === 0 ? 0 : effectiveUid
  const expectedGid = effectiveUid === 0 ? 0 : effectiveGid
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedUid ||
    stat.gid !== expectedGid ||
    (stat.mode & 0o777) !== mode
  ) {
    throw new Error(`${label} metadata is not server-owned and sealed: ${path}`)
  }
  return path
}

const sanitizedProcessEnv = (env: NodeJS.ProcessEnv) => {
  const sanitized = { ...env }
  for (const key of Object.keys(sanitized)) {
    if (
      key === 'BASH_ENV' ||
      key === 'BASHOPTS' ||
      key === 'CDPATH' ||
      key === 'ENV' ||
      key === 'GLIBC_TUNABLES' ||
      key === 'NODE_OPTIONS' ||
      key === 'PYTHONHOME' ||
      key === 'PYTHONPATH' ||
      key === 'PYTHONSTARTUP' ||
      key === 'RUBYOPT' ||
      key === 'SHELLOPTS' ||
      key === 'SSH_ASKPASS' ||
      key.startsWith('DYLD_') ||
      key.startsWith('GIT_') ||
      key.startsWith('LD_') ||
      key.startsWith('PERL5')
    ) {
      delete sanitized[key]
    }
  }
  return sanitized
}

const privilegedGitEnvironment = (
  trustedPath: string,
  configEntries: readonly PrivilegedGitConfigEntry[] = [],
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {
    HOME: '/nonexistent',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: trustedPath,
    GIT_CONFIG_COUNT: String(configEntries.length),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  }
  for (const [index, [key, value]] of configEntries.entries()) {
    environment[`GIT_CONFIG_KEY_${index}`] = key
    environment[`GIT_CONFIG_VALUE_${index}`] = value
  }
  return environment
}

const serverOwnedRemoteConfig = (
  remoteUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): readonly PrivilegedGitConfigEntry[] => {
  let parsed: URL
  try {
    parsed = new URL(remoteUrl)
  } catch {
    return []
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') return []
  if (parsed.username || parsed.password) throw new Error('workspace origin URL must not contain credentials')
  const config: PrivilegedGitConfigEntry[] = [
    ['http.proxy', ''],
    ['http.sslVerify', 'true'],
    ['http.https://github.com/.proxy', ''],
    ['http.https://github.com/.sslVerify', 'true'],
  ]
  const token = (env.GITHUB_TOKEN ?? env.GH_TOKEN)?.trim()
  if (!token) return config
  if (/[\r\n]/.test(token)) throw new Error('server-owned Git token contains invalid control characters')
  const encoded = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  config.push(['http.https://github.com/.extraHeader', `AUTHORIZATION: basic ${encoded}`])
  return config
}

const privilegedGitOverrideValue = (key: string) => {
  const normalized = key.toLowerCase()
  if (normalized === 'core.fsmonitor') return 'false'
  if (normalized.startsWith('submodule.') && normalized.endsWith('.update')) return 'checkout'
  return ''
}

const parseGitRefs = (output: string, label: string) => {
  const refs: Record<string, string> = {}
  for (const line of output.split('\n')) {
    if (!line) continue
    const [objectId, ref, ...remainder] = line.split('\t')
    if (
      remainder.length > 0 ||
      !EXACT_GIT_OBJECT_ID.test(objectId ?? '') ||
      !ref ||
      ref.length > 1024 ||
      !PERSISTED_GIT_REF.test(ref) ||
      refs[ref] != null
    ) {
      throw new Error(`${label} returned invalid Git ref metadata`)
    }
    refs[ref] = objectId!
  }
  return refs
}

const publicationRefsEqual = (left: Record<string, string>, right: Record<string, string>) => {
  const leftEntries = Object.entries(left).sort(([leftRef], [rightRef]) => leftRef.localeCompare(rightRef))
  const rightEntries = Object.entries(right).sort(([leftRef], [rightRef]) => leftRef.localeCompare(rightRef))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

const privilegedGitSubcommand = (args: readonly string[]) => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '-c' || arg === '-C' || arg === '--git-dir' || arg === '--work-tree') {
      index += 1
      continue
    }
    if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) continue
    if (arg.startsWith('-')) continue
    return arg
  }
  return null
}

const confinementFailedReason = (reason: string) => `${CONFINEMENT_FAILED_REASON_PREFIX}${reason}`
const isConfinementFailedReason = (reason: string | null) =>
  reason != null && reason.startsWith(CONFINEMENT_FAILED_REASON_PREFIX)

const inClusterDiscoveryEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const discovery: NodeJS.ProcessEnv = {}
  for (const key of ['KUBERNETES_SERVICE_HOST', 'KUBERNETES_SERVICE_PORT'] as const) {
    const value = env[key]
    if (value) discovery[key] = value
  }
  return discovery
}

const assertNoSymlinkComponents = (root: string, candidate: string) => {
  const canonicalRoot = realpathSync(root)
  const resolved = resolve(candidate)
  if (!isInsidePath(canonicalRoot, resolved)) throw new Error(`workspace must stay under ${canonicalRoot}`)
  let current = canonicalRoot
  const rel = relative(canonicalRoot, resolved)
  if (!rel) return
  for (const component of rel.split(sep)) {
    current = join(current, component)
    if (lstatSync(current).isSymbolicLink()) throw new Error(`workspace path must not contain symlinks: ${current}`)
  }
}

const chownTree = (root: string, uid: number, gid: number) => {
  if ((process.geteuid?.() ?? 0) === uid && (process.getegid?.() ?? 0) === gid) {
    chmodSync(root, 0o700)
    return
  }
  const visit = (path: string) => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      lchownSync(path, uid, gid)
      return
    }
    chownSync(path, uid, gid)
    if (!stat.isDirectory()) return
    for (const entry of readdirSync(path)) visit(join(path, entry))
  }
  for (const entry of readdirSync(root)) visit(join(root, entry))
  chownSync(root, 0, gid)
  chmodSync(root, 0o770)
}

const sealTree = (root: string) => {
  if ((process.geteuid?.() ?? -1) !== 0 || !existsSync(root)) return
  const visit = (path: string) => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      lchownSync(path, 0, 0)
      return
    }
    chownSync(path, 0, 0)
    const currentMode = stat.mode & 0o7777
    chmodSync(path, currentMode & ~0o022)
    if (!stat.isDirectory()) return
    for (const entry of readdirSync(path)) visit(join(path, entry))
  }
  visit(root)
  chmodSync(root, 0o700)
}

const assertNoHardlinks = (root: string) => {
  const visit = (path: string) => {
    const stat = lstatSync(path)
    if (!stat.isDirectory() && !stat.isSymbolicLink() && stat.nlink > 1) {
      throw new Error(`workspace contains a hard-linked file and cannot be isolated: ${path}`)
    }
    if (!stat.isDirectory()) return
    for (const entry of readdirSync(path)) visit(join(path, entry))
  }
  visit(root)
}

const nearestExistingAncestor = (path: string) => {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) throw new Error(`no existing ancestor for path: ${path}`)
    current = parent
  }
  return current
}

export class WorkspaceLeaseManager {
  readonly config: AgentsShellConfig
  readonly bootId = randomUUID()
  private readonly bySession = new Map<string, string>()
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly workspaceOperations = new Map<string, Promise<void>>()
  private readonly activePrivilegedGitProcesses = new Set<ChildProcess>()
  private readonly uidAllocator: (() => number) | null
  private readonly onLeaseInvalidated: ((lease: WorkspaceLease, reason: string) => void) | null
  private state: WorkspaceLeaseState

  constructor(config: AgentsShellConfig, options: WorkspaceLeaseManagerOptions = {}) {
    this.config = config
    this.uidAllocator = options.uidAllocator ?? null
    this.onLeaseInvalidated = options.onLeaseInvalidated ?? null
    this.validateConfig(options.uidAllocator != null)
    if (!existsSync(config.workspaceSeedPath)) {
      throw new Error(`workspace seed does not exist: ${config.workspaceSeedPath}`)
    }
    const workspaceRoot = resolve(config.workspaceRoot)
    const controlRoot = dirname(config.leaseStatePath)
    prepareServerDirectory(workspaceRoot, config.workspaceLeaseRoot, 0o755, 'workspace lease root')
    prepareServerDirectory(workspaceRoot, controlRoot, 0o711, 'agents-shell control root')
    prepareServerDirectory(workspaceRoot, config.sessionRuntimeRoot, 0o711, 'session runtime root')
    const inspectionScratchRoot = prepareServerDirectory(
      workspaceRoot,
      join(controlRoot, 'git-inspections'),
      0o711,
      'Git inspection scratch root',
    )
    for (const entry of readdirSync(inspectionScratchRoot)) {
      rmSync(join(inspectionScratchRoot, entry), { recursive: true, force: true })
    }
    this.state = this.loadState()
    this.recoverPersistedLeases()
    this.audit('workspace_lease_manager_started', null, {
      bootId: this.bootId,
      persistedLeaseCount: this.state.leases.length,
    })
  }

  private validateConfig(hasInjectedUidAllocator: boolean) {
    assertPositiveInteger(this.config.leaseTtlSeconds, 'leaseTtlSeconds')
    assertPositiveInteger(this.config.sessionUidStart, 'sessionUidStart')
    assertPositiveInteger(this.config.sessionUidEnd, 'sessionUidEnd')
    assertPositiveInteger(this.config.inspectionUid, 'inspectionUid')
    assertPositiveInteger(this.config.inspectionGid, 'inspectionGid')
    if (this.config.sessionUidStart > this.config.sessionUidEnd) {
      throw new Error('sessionUidStart must not exceed sessionUidEnd')
    }

    const effectiveUid = process.geteuid?.() ?? 0
    if (
      !hasInjectedUidAllocator &&
      effectiveUid !== 0 &&
      (this.config.sessionUidStart !== effectiveUid || this.config.sessionUidEnd !== effectiveUid)
    ) {
      throw new Error('agents-shell must run as root to allocate per-session UIDs')
    }
  }

  private async withWorkspaceOperation<A>(workspacePath: string, action: () => Promise<A>): Promise<A> {
    const key = resolve(workspacePath)
    const previous = this.workspaceOperations.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise
    })
    this.workspaceOperations.set(key, current)
    await previous.catch(() => undefined)
    try {
      return await action()
    } finally {
      release()
      if (this.workspaceOperations.get(key) === current) this.workspaceOperations.delete(key)
    }
  }

  private parsePersistedLease(value: unknown, index: number): WorkspaceLease {
    const label = `lease[${index}]`
    if (!isRecord(value)) throw new Error(`invalid persisted ${label}`)
    const leaseId = persistedString(value, 'leaseId', label)
    const sessionHash = persistedString(value, 'sessionHash', label)
    const subject = persistedString(value, 'subject', label)
    const workspacePath = persistedString(value, 'workspacePath', label)
    const branch = persistedString(value, 'branch', label)
    const head = persistedString(value, 'head', label)
    const publicationHead = value.publicationHead == null ? head : persistedString(value, 'publicationHead', label)
    const persistedPublicationRefs = value.publicationRefs
    const issuedAt = persistedString(value, 'issuedAt', label)
    const renewedAt = persistedString(value, 'renewedAt', label)
    const expiresAt = persistedString(value, 'expiresAt', label)
    const status = persistedString(value, 'status', label) as WorkspaceLeaseStatus
    const bootId = persistedString(value, 'bootId', label)
    const reason = value.reason
    const created = value.created == null ? false : value.created
    const activeJobIds = value.activeJobIds
    const device = persistedInteger(value, 'device', label)
    const inode = persistedInteger(value, 'inode', label)
    const uid = persistedInteger(value, 'uid', label)
    const gid = persistedInteger(value, 'gid', label)

    if (!PERSISTED_ID.test(leaseId)) throw new Error(`invalid persisted ${label} leaseId`)
    if (!PERSISTED_SESSION_HASH.test(sessionHash)) throw new Error(`invalid persisted ${label} sessionHash`)
    if (!subject || subject.length > 512) throw new Error(`invalid persisted ${label} subject`)
    if (branch.length > 512) throw new Error(`invalid persisted ${label} branch`)
    if (!EXACT_GIT_OBJECT_ID.test(head)) throw new Error(`invalid persisted ${label} head`)
    if (!EXACT_GIT_OBJECT_ID.test(publicationHead)) throw new Error(`invalid persisted ${label} publicationHead`)
    if (!PERSISTED_LEASE_STATUSES.has(status)) throw new Error(`invalid persisted ${label} status`)
    if (!PERSISTED_ID.test(bootId)) throw new Error(`invalid persisted ${label} bootId`)
    if (typeof created !== 'boolean') throw new Error(`invalid persisted ${label} created`)
    let publicationRefs: Record<string, string>
    if (persistedPublicationRefs == null) {
      publicationRefs = created ? { [`refs/heads/${branch}`]: publicationHead } : {}
    } else {
      if (!isRecord(persistedPublicationRefs) || Object.keys(persistedPublicationRefs).length > 4096) {
        throw new Error(`invalid persisted ${label} publicationRefs`)
      }
      publicationRefs = {}
      for (const [ref, objectId] of Object.entries(persistedPublicationRefs)) {
        if (
          ref.length > 1024 ||
          !PERSISTED_GIT_REF.test(ref) ||
          typeof objectId !== 'string' ||
          !EXACT_GIT_OBJECT_ID.test(objectId)
        ) {
          throw new Error(`invalid persisted ${label} publicationRefs`)
        }
        publicationRefs[ref] = objectId
      }
    }
    if (reason !== null && (typeof reason !== 'string' || reason.length > 1024)) {
      throw new Error(`invalid persisted ${label} reason`)
    }
    if (!Array.isArray(activeJobIds) || activeJobIds.length > 1024) {
      throw new Error(`invalid persisted ${label} activeJobIds`)
    }
    const jobs = activeJobIds.map((jobId) => {
      if (typeof jobId !== 'string' || !PERSISTED_ID.test(jobId)) {
        throw new Error(`invalid persisted ${label} activeJobIds`)
      }
      return jobId
    })
    if (new Set(jobs).size !== jobs.length) throw new Error(`invalid persisted ${label} duplicate activeJobIds`)
    if (uid < this.config.sessionUidStart || uid > this.config.sessionUidEnd || gid !== uid) {
      throw new Error(`invalid persisted ${label} lease identity`)
    }
    const issuedTime = parseTime(issuedAt)
    const renewedTime = parseTime(renewedAt)
    const expiryTime = parseTime(expiresAt)
    if (issuedTime > renewedTime || renewedTime > expiryTime) {
      throw new Error(`invalid persisted ${label} timestamp order`)
    }

    const root = resolve(this.config.workspaceRoot)
    const lexicalWorkspacePath = resolve(workspacePath)
    if (
      !isAbsolute(workspacePath) ||
      lexicalWorkspacePath !== workspacePath ||
      lexicalWorkspacePath === root ||
      !isInsidePath(root, lexicalWorkspacePath)
    ) {
      throw new Error(`invalid persisted ${label} workspacePath`)
    }
    for (const forbidden of [
      resolve(this.config.workspaceSeedPath),
      resolve(dirname(this.config.leaseStatePath)),
      resolve(this.config.sessionRuntimeRoot),
    ]) {
      if (lexicalWorkspacePath === forbidden || isInsidePath(forbidden, lexicalWorkspacePath)) {
        throw new Error(`invalid persisted ${label} workspacePath`)
      }
    }
    if (created && !isInsidePath(resolve(this.config.workspaceLeaseRoot), lexicalWorkspacePath)) {
      throw new Error(`invalid persisted ${label} created workspacePath`)
    }
    const runtimePath = resolve(this.config.sessionRuntimeRoot, leaseId)
    if (!isInsidePath(resolve(this.config.sessionRuntimeRoot), runtimePath)) {
      throw new Error(`invalid persisted ${label} runtimePath`)
    }
    if (status === 'active') {
      if (!existsSync(lexicalWorkspacePath)) throw new Error(`invalid persisted ${label} missing workspace`)
      assertNoSymlinkComponents(root, lexicalWorkspacePath)
      if (realpathSync(lexicalWorkspacePath) !== lexicalWorkspacePath) {
        throw new Error(`invalid persisted ${label} canonical workspacePath`)
      }
      const workspaceStat = statSync(lexicalWorkspacePath)
      if (!workspaceStat.isDirectory() || workspaceStat.dev !== device || workspaceStat.ino !== inode) {
        throw new Error(`invalid persisted ${label} workspace identity`)
      }
      if (existsSync(runtimePath)) {
        assertNoSymlinkComponents(root, runtimePath)
        if (realpathSync(runtimePath) !== runtimePath || !statSync(runtimePath).isDirectory()) {
          throw new Error(`invalid persisted ${label} runtime identity`)
        }
      }
    }

    return {
      leaseId,
      sessionHash,
      subject,
      workspacePath: lexicalWorkspacePath,
      branch,
      head,
      publicationHead,
      publicationRefs,
      device,
      inode,
      uid,
      gid,
      issuedAt,
      renewedAt,
      expiresAt,
      status,
      bootId,
      activeJobIds: jobs,
      reason: reason as string | null,
      created,
    }
  }

  private loadState(): WorkspaceLeaseState {
    if (!existsSync(this.config.leaseStatePath)) {
      return { version: STATE_VERSION, nextUid: this.config.sessionUidStart, leases: [] }
    }
    const stateStat = lstatSync(this.config.leaseStatePath)
    const effectiveUid = process.geteuid?.() ?? stateStat.uid
    const effectiveGid = process.getegid?.() ?? stateStat.gid
    if (
      !stateStat.isFile() ||
      stateStat.isSymbolicLink() ||
      stateStat.nlink !== 1 ||
      stateStat.uid !== effectiveUid ||
      stateStat.gid !== effectiveGid
    ) {
      throw new Error(`invalid workspace lease state: ${this.config.leaseStatePath}`)
    }
    const parsed = JSON.parse(readFileSync(this.config.leaseStatePath, 'utf8')) as unknown
    if (!isRecord(parsed) || parsed.version !== STATE_VERSION || !Array.isArray(parsed.leases)) {
      throw new Error(`invalid workspace lease state: ${this.config.leaseStatePath}`)
    }
    if (
      !Number.isSafeInteger(parsed.nextUid) ||
      (parsed.nextUid as number) < this.config.sessionUidStart ||
      (parsed.nextUid as number) > this.config.sessionUidEnd
    ) {
      throw new Error(`invalid workspace lease state: ${this.config.leaseStatePath}`)
    }
    const leases = parsed.leases.map((lease, index) => this.parsePersistedLease(lease, index))
    const leaseIds = leases.map((lease) => lease.leaseId)
    if (new Set(leaseIds).size !== leaseIds.length) {
      throw new Error(`invalid workspace lease state: duplicate leaseId in ${this.config.leaseStatePath}`)
    }
    return { version: STATE_VERSION, nextUid: parsed.nextUid as number, leases }
  }

  private persist() {
    const directory = dirname(this.config.leaseStatePath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.config.leaseStatePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    const fd = openSync(temporary, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, this.config.leaseStatePath)
    const directoryFd = openSync(directory, 'r')
    try {
      fsyncSync(directoryFd)
    } finally {
      closeSync(directoryFd)
    }
  }

  private audit(event: string, auth: AuthContext | null, payload: Record<string, unknown>) {
    writeAuditLog(this.config, event, auth, payload, { required: true })
  }

  private completeConfinement(lease: WorkspaceLease, reason: string) {
    let failure: unknown = null
    try {
      this.onLeaseInvalidated?.(lease, reason)
    } catch (error) {
      failure = error
    }
    for (const path of [lease.workspacePath, this.runtimePath(lease)]) {
      try {
        sealTree(path)
      } catch (error) {
        failure ??= error
      }
    }
    return failure
  }

  private finishConfinement(
    lease: WorkspaceLease,
    targetStatus: Exclude<WorkspaceLeaseStatus, 'active' | 'quarantined'>,
    reason: string,
  ) {
    const confinementError = this.completeConfinement(lease, reason)
    if (confinementError) {
      lease.status = 'quarantined'
      lease.reason = confinementFailedReason(reason)
      this.persist()
      return confinementError
    }
    lease.status = targetStatus
    lease.reason = reason
    lease.activeJobIds = []
    this.persist()
    return null
  }

  private clearExpiryTimer(leaseId: string) {
    const timer = this.expiryTimers.get(leaseId)
    if (timer) clearTimeout(timer)
    this.expiryTimers.delete(leaseId)
  }

  private scheduleExpiry(lease: WorkspaceLease) {
    this.clearExpiryTimer(lease.leaseId)
    if (lease.status !== 'active') return
    const timer = setTimeout(
      () => {
        this.expiryTimers.delete(lease.leaseId)
        try {
          this.expireById(lease.leaseId, null, 'lease_expired')
        } catch (error) {
          console.error('[agents-shell] failed to complete scheduled workspace lease expiry', error)
        }
      },
      Math.max(1, parseTime(lease.expiresAt) - Date.now()),
    )
    this.expiryTimers.set(lease.leaseId, timer)
  }

  private expiryForAuth(auth: AuthContext, now: number) {
    const tokenExpiresAt = typeof auth.payload.exp === 'number' ? auth.payload.exp * 1000 : Number.POSITIVE_INFINITY
    const expiresAt = Math.min(now + this.config.leaseTtlSeconds * 1000, tokenExpiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new Error('workspace lease cannot outlive an expired access token')
    }
    return expiresAt
  }

  private renewActiveLease(lease: WorkspaceLease, auth: AuthContext) {
    if (lease.subject !== auth.subject) throw new Error('workspace belongs to another authenticated subject')
    const now = Date.now()
    const previousRenewedAt = lease.renewedAt
    const previousExpiresAt = lease.expiresAt
    lease.renewedAt = iso(now)
    lease.expiresAt = iso(this.expiryForAuth(auth, now))
    try {
      this.persist()
    } catch (error) {
      lease.renewedAt = previousRenewedAt
      lease.expiresAt = previousExpiresAt
      throw error
    }
    try {
      this.audit('workspace_lease_renewed', auth, {
        leaseId: lease.leaseId,
        sessionHash: lease.sessionHash,
        previousExpiresAt,
        renewedAt: lease.renewedAt,
        expiresAt: lease.expiresAt,
      })
    } catch (error) {
      this.invalidateWithoutAudit(lease, 'audit_persistence_failed')
      throw error
    }
    this.scheduleExpiry(lease)
    return this.publicLease(lease)
  }

  private invalidateWithoutAudit(lease: WorkspaceLease, reason: string) {
    this.clearExpiryTimer(lease.leaseId)
    lease.status = 'revoked'
    lease.reason = reason
    for (const [sessionId, leaseId] of this.bySession) {
      if (leaseId === lease.leaseId) this.bySession.delete(sessionId)
    }
    this.persist()
    const confinementError = this.finishConfinement(lease, 'revoked', reason)
    if (confinementError) throw confinementError
  }

  private recoverPersistedLeases() {
    const recovered: WorkspaceLease[] = []
    for (const lease of this.state.leases) {
      if (lease.status !== 'active') continue
      lease.status = 'orphaned'
      lease.reason = 'server_restart'
      recovered.push(lease)
    }
    if (recovered.length === 0) return
    this.persist()
    for (const lease of recovered) {
      const confinementError = this.finishConfinement(lease, 'orphaned', 'server_restart')
      this.audit('workspace_lease_restart_orphaned', null, {
        leaseId: lease.leaseId,
        sessionHash: lease.sessionHash,
        workspacePath: lease.workspacePath,
        priorBootId: lease.bootId,
        bootId: this.bootId,
        confinementCompleted: confinementError == null,
      })
      if (confinementError) throw confinementError
    }
  }

  private allocateUid() {
    if (this.uidAllocator) {
      const uid = this.uidAllocator()
      if (!Number.isSafeInteger(uid) || uid < this.config.sessionUidStart || uid > this.config.sessionUidEnd) {
        throw new Error(`session UID allocator returned an out-of-range UID: ${uid}`)
      }
      return uid
    }
    const unavailable = new Set(
      this.state.leases.filter((lease) => lease.status !== 'released').map((lease) => lease.uid),
    )
    const rangeSize = this.config.sessionUidEnd - this.config.sessionUidStart + 1
    let uid =
      this.state.nextUid >= this.config.sessionUidStart && this.state.nextUid <= this.config.sessionUidEnd
        ? this.state.nextUid
        : this.config.sessionUidStart
    for (let offset = 0; offset < rangeSize; offset += 1) {
      if (!unavailable.has(uid)) {
        this.state.nextUid = uid === this.config.sessionUidEnd ? this.config.sessionUidStart : uid + 1
        return uid
      }
      uid = uid === this.config.sessionUidEnd ? this.config.sessionUidStart : uid + 1
    }
    throw new Error('agents-shell session UID range exhausted')
  }

  private selectedBase(baseRef: string) {
    if (EXACT_GIT_OBJECT_ID.test(baseRef)) {
      return { resolveRef: baseRef, remoteBranch: null, remoteTrackingRef: null }
    }
    const prefix = baseRef.startsWith('refs/remotes/origin/')
      ? 'refs/remotes/origin/'
      : baseRef.startsWith('origin/')
        ? 'origin/'
        : null
    if (!prefix) {
      throw new Error('baseRef must be an exact Git object ID or an origin/<branch> remote-tracking ref')
    }
    const branch = baseRef.slice(prefix.length)
    const checked = this.runPrivilegedGit(
      [...PRIVILEGED_GIT_BASE_ARGS, 'check-ref-format', '--branch', branch],
      undefined,
      new Set([0, 1]),
    )
    if (checked.status !== 0 || checked.stdout.trim() !== branch) {
      throw new Error(`invalid origin branch in baseRef: ${baseRef}`)
    }
    const remoteTrackingRef = `refs/remotes/origin/${branch}`
    return {
      resolveRef: remoteTrackingRef,
      remoteBranch: `refs/heads/${branch}`,
      remoteTrackingRef,
    }
  }

  private runPrivilegedGit(
    args: string[],
    cwd?: string,
    acceptedStatuses = new Set([0]),
    configEntries: readonly PrivilegedGitConfigEntry[] = [],
    isolatedGitDirectory?: string,
  ) {
    const subcommand = privilegedGitSubcommand(args)
    if (subcommand && PRIVILEGED_GIT_NETWORK_SUBCOMMANDS.has(subcommand)) {
      throw new Error(`network Git subcommand ${subcommand} must use asynchronous privileged execution`)
    }
    const executable = trustedExecutablePath(this.config.trustedExecutables, 'git')
    const effectiveConfigEntries: readonly PrivilegedGitConfigEntry[] = cwd
      ? [['safe.directory', cwd], ...configEntries]
      : configEntries
    const result = spawnSync(executable, args, {
      cwd,
      env: {
        ...privilegedGitEnvironment(trustedPathValue(this.config.trustedExecutables), effectiveConfigEntries),
        ...(isolatedGitDirectory ? { GIT_DIR: isolatedGitDirectory } : {}),
      },
      encoding: 'utf8',
      timeout: PRIVILEGED_GIT_TIMEOUT_MS,
      maxBuffer: PRIVILEGED_GIT_MAX_BUFFER_BYTES,
    })
    if (result.error) throw result.error
    if (result.status == null || !acceptedStatuses.has(result.status)) {
      throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  private killPrivilegedGitProcess(child: ChildProcess) {
    if (child.pid && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGKILL')
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL')
        return
      }
    }
    child.kill('SIGKILL')
  }

  private async runPrivilegedGitAsync(
    args: string[],
    cwd?: string,
    acceptedStatuses = new Set([0]),
    configEntries: readonly PrivilegedGitConfigEntry[] = [],
    isolatedGitDirectory?: string,
  ): Promise<PrivilegedGitResult> {
    const subcommand = privilegedGitSubcommand(args)
    if (!subcommand || !PRIVILEGED_GIT_NETWORK_SUBCOMMANDS.has(subcommand)) {
      throw new Error('asynchronous privileged Git is reserved for network subcommands')
    }
    const executable = trustedExecutablePath(this.config.trustedExecutables, 'git')
    const effectiveConfigEntries: readonly PrivilegedGitConfigEntry[] = cwd
      ? [['safe.directory', cwd], ...configEntries]
      : configEntries
    const child = spawn(executable, args, {
      cwd,
      env: {
        ...privilegedGitEnvironment(trustedPathValue(this.config.trustedExecutables), effectiveConfigEntries),
        ...(isolatedGitDirectory ? { GIT_DIR: isolatedGitDirectory } : {}),
      },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.activePrivilegedGitProcesses.add(child)

    return await new Promise<PrivilegedGitResult>((resolvePromise, reject) => {
      let stdout = ''
      let stderr = ''
      let outputBytes = 0
      let terminalError: Error | null = null
      let settled = false
      const timeout = setTimeout(() => {
        terminalError ??= new Error(`git ${args.join(' ')} timed out after ${PRIVILEGED_GIT_TIMEOUT_MS}ms`)
        this.killPrivilegedGitProcess(child)
      }, PRIVILEGED_GIT_TIMEOUT_MS)

      const cleanup = () => {
        clearTimeout(timeout)
        this.activePrivilegedGitProcesses.delete(child)
      }
      const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        outputBytes += Buffer.byteLength(text)
        if (outputBytes > PRIVILEGED_GIT_MAX_BUFFER_BYTES) {
          terminalError ??= new Error(`git ${args.join(' ')} output exceeded ${PRIVILEGED_GIT_MAX_BUFFER_BYTES} bytes`)
          this.killPrivilegedGitProcess(child)
          return
        }
        if (target === 'stdout') stdout += text
        else stderr += text
      }

      child.stdout?.on('data', (chunk: Buffer | string) => append('stdout', chunk))
      child.stderr?.on('data', (chunk: Buffer | string) => append('stderr', chunk))
      child.once('error', (error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      })
      child.once('close', (status) => {
        if (settled) return
        settled = true
        cleanup()
        if (terminalError) {
          reject(terminalError)
          return
        }
        if (status == null || !acceptedStatuses.has(status)) {
          reject(new Error(`git ${args.join(' ')} failed: ${(stderr || stdout).trim()}`))
          return
        }
        resolvePromise({ status, stdout, stderr })
      })
    })
  }

  private localGitConfigKeys(cwd: string, pattern: string) {
    const keys = new Set<string>()
    const worktreeConfig = this.runPrivilegedGit(
      [
        ...PRIVILEGED_GIT_BASE_ARGS,
        '-C',
        cwd,
        '--git-dir',
        join(cwd, '.git'),
        '--work-tree',
        cwd,
        'config',
        '--local',
        '--no-includes',
        '--bool',
        '--get',
        'extensions.worktreeConfig',
      ],
      cwd,
      new Set([0, 1]),
    )
    const scopes =
      worktreeConfig.status === 0 && worktreeConfig.stdout.trim() === 'true' ? ['--local', '--worktree'] : ['--local']
    for (const scope of scopes) {
      const result = this.runPrivilegedGit(
        [
          ...PRIVILEGED_GIT_BASE_ARGS,
          '-C',
          cwd,
          '--git-dir',
          join(cwd, '.git'),
          '--work-tree',
          cwd,
          'config',
          scope,
          '--no-includes',
          '--null',
          '--name-only',
          '--get-regexp',
          pattern,
        ],
        cwd,
        new Set([0, 1]),
      )
      if (result.status === 0) {
        for (const key of result.stdout.split('\0')) {
          if (key) keys.add(key)
        }
      }
    }
    return [...keys].sort()
  }

  private executableGitConfigOverrides(cwd: string, label: string) {
    const includes = this.localGitConfigKeys(cwd, PRIVILEGED_GIT_INCLUDE_CONFIG_PATTERN)
    if (includes.length > 0) {
      throw new Error(`${label} rejects repository config includes: ${includes.join(', ')}`)
    }
    const executableKeys = this.localGitConfigKeys(cwd, PRIVILEGED_GIT_EXECUTABLE_CONFIG_PATTERN)
    const overrides: string[] = []
    const requiredFilters = new Set<string>()
    for (const key of executableKeys) {
      overrides.push('-c', `${key}=${privilegedGitOverrideValue(key)}`)
      const match = /^filter\.(.*)\.(clean|smudge|process)$/i.exec(key)
      if (match?.[1]) requiredFilters.add(`filter.${match[1]}.required`)
    }
    for (const key of [...requiredFilters].sort()) overrides.push('-c', `${key}=false`)
    return overrides
  }

  readOnlyGitConfigOverrides(cwd: string) {
    return [
      '--git-dir',
      join(cwd, '.git'),
      '--work-tree',
      cwd,
      ...this.executableGitConfigOverrides(cwd, 'read-only Git'),
    ]
  }

  prepareReadOnlyGitIndexScratch(repositoryRoot: string, uid: number, gid: number): ReadOnlyGitIndexScratch {
    const controlRoot = dirname(this.config.leaseStatePath)
    const inspectionsRoot = prepareServerDirectory(
      this.config.workspaceRoot,
      join(controlRoot, 'git-inspections'),
      0o711,
      'Git inspection scratch root',
    )

    const scratch = mkdtempSync(join(inspectionsRoot, 'inspection-'))
    const configPath = join(scratch, 'gitconfig')
    const hooksPath = join(scratch, 'hooks')
    const sourceIndexPath = join(repositoryRoot, '.git', 'index')
    const destinationIndexPath = join(scratch, 'index')
    let configFd: number | null = null
    let hooksFd: number | null = null
    let sourceFd: number | null = null
    let destinationFd: number | null = null
    try {
      configFd = openSync(
        configPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      )
      fsyncSync(configFd)
      fchmodSync(configFd, 0o600)
      fchownSync(configFd, uid, gid)
      mkdirSync(hooksPath, { mode: 0o700 })
      hooksFd = openSync(hooksPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
      fchmodSync(hooksFd, 0o700)
      fchownSync(hooksFd, uid, gid)
      sourceFd = openSync(sourceIndexPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      const sourceStat = fstatSync(sourceFd)
      if (!sourceStat.isFile() || sourceStat.nlink !== 1) {
        throw new Error('Git index must be a single-link regular file')
      }
      destinationFd = openSync(
        destinationIndexPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      )
      writeFileSync(destinationFd, readFileSync(sourceFd))
      fsyncSync(destinationFd)
      fchmodSync(destinationFd, 0o600)
      fchownSync(destinationFd, uid, gid)
      chmodSync(scratch, 0o700)
      chownSync(scratch, uid, gid)
      const configStat = fstatSync(configFd)
      const hooksStat = fstatSync(hooksFd)
      const destinationStat = fstatSync(destinationFd)
      const scratchStat = lstatSync(scratch)
      if (
        !configStat.isFile() ||
        configStat.nlink !== 1 ||
        configStat.uid !== uid ||
        configStat.gid !== gid ||
        (configStat.mode & 0o777) !== 0o600 ||
        !hooksStat.isDirectory() ||
        hooksStat.uid !== uid ||
        hooksStat.gid !== gid ||
        (hooksStat.mode & 0o777) !== 0o700 ||
        !destinationStat.isFile() ||
        destinationStat.nlink !== 1 ||
        destinationStat.uid !== uid ||
        destinationStat.gid !== gid ||
        (destinationStat.mode & 0o777) !== 0o600 ||
        !scratchStat.isDirectory() ||
        scratchStat.uid !== uid ||
        scratchStat.gid !== gid ||
        (scratchStat.mode & 0o777) !== 0o700
      ) {
        throw new Error('Git inspection scratch metadata does not match the inspection identity')
      }
    } catch (error) {
      rmSync(scratch, { recursive: true, force: true })
      throw error
    } finally {
      if (configFd != null) closeSync(configFd)
      if (hooksFd != null) closeSync(hooksFd)
      if (destinationFd != null) closeSync(destinationFd)
      if (sourceFd != null) closeSync(sourceFd)
    }
    return {
      configPath,
      hooksPath,
      indexPath: destinationIndexPath,
      writableRoot: scratch,
      cleanup: () => rmSync(scratch, { recursive: true, force: true }),
    }
  }

  private privilegedGitArgs(args: string[], cwd?: string) {
    if (!cwd) return [...PRIVILEGED_GIT_BASE_ARGS, ...args]
    const overrides = this.executableGitConfigOverrides(cwd, 'privileged Git')
    return [...PRIVILEGED_GIT_BASE_ARGS, '--git-dir', join(cwd, '.git'), '--work-tree', cwd, ...overrides, ...args]
  }

  private git(args: string[], cwd?: string, configEntries: readonly PrivilegedGitConfigEntry[] = []) {
    const result = this.runPrivilegedGit(this.privilegedGitArgs(args, cwd), cwd, new Set([0]), configEntries)
    return result.stdout.trim()
  }

  private async gitAsync(args: string[], cwd?: string, configEntries: readonly PrivilegedGitConfigEntry[] = []) {
    const result = await this.runPrivilegedGitAsync(this.privilegedGitArgs(args, cwd), cwd, new Set([0]), configEntries)
    return result.stdout.trim()
  }

  private isClean(path: string) {
    return this.git(['status', '--porcelain=v1', '--untracked-files=all'], path) === ''
  }

  private localPublicationRefs(path: string) {
    const refs = parseGitRefs(
      this.git(['for-each-ref', '--format=%(objectname)%09%(refname)'], path),
      'local repository',
    )
    return Object.fromEntries(Object.entries(refs).filter(([ref]) => !ref.startsWith('refs/remotes/')))
  }

  private async createdWorkspacePublication(lease: WorkspaceLease) {
    const head = this.git(['rev-parse', 'HEAD'], lease.workspacePath)
    const currentRefs = this.localPublicationRefs(lease.workspacePath)
    const changedRefs = Object.entries(currentRefs).filter(([ref, objectId]) => lease.publicationRefs[ref] !== objectId)
    const headChanged = head !== lease.publicationHead
    if (!headChanged && changedRefs.length === 0) {
      return { head, headAdvanced: false, publicationProven: true }
    }

    const approvedRemoteUrl = this.git(['remote', 'get-url', 'origin'], this.config.workspaceSeedPath)
    const workspaceRemoteUrl = this.git(['remote', 'get-url', 'origin'], lease.workspacePath)
    if (workspaceRemoteUrl !== approvedRemoteUrl) {
      return { head, headAdvanced: true, publicationProven: false }
    }

    const remoteConfig = serverOwnedRemoteConfig(approvedRemoteUrl)
    const advertisedResult = await this.runPrivilegedGitAsync(
      [...PRIVILEGED_GIT_BASE_ARGS, 'ls-remote', '--refs', approvedRemoteUrl],
      undefined,
      new Set([0]),
      remoteConfig,
      '/dev/null',
    )
    const advertisedRefs = parseGitRefs(advertisedResult.stdout.trim(), 'approved remote')
    const changedRefsProven = changedRefs.every(([ref, objectId]) => advertisedRefs[ref] === objectId)
    const headProven =
      !headChanged || changedRefs.some(([ref, objectId]) => objectId === head && advertisedRefs[ref] === head)
    return {
      head,
      headAdvanced: headChanged || changedRefs.length > 0,
      publicationProven: changedRefsProven && headProven,
    }
  }

  private resolveWorkspacePath(path: string) {
    const leaseRoot = realpathSync(this.config.workspaceLeaseRoot)
    const resolved = isAbsolute(path) ? resolve(path) : resolve(leaseRoot, path)
    if (!existsSync(resolved)) throw new Error(`workspace does not exist: ${resolved}`)
    assertNoSymlinkComponents(leaseRoot, resolved)
    const canonical = realpathSync(resolved)
    if (!isInsidePath(leaseRoot, canonical) || canonical === leaseRoot) {
      throw new Error(`workspace must be a contained child of ${leaseRoot}`)
    }
    const seed = realpathSync(this.config.workspaceSeedPath)
    if (canonical === seed || isInsidePath(seed, canonical)) throw new Error('shared seed workspace cannot be leased')
    return canonical
  }

  private prepareExistingWorkspace(path: string, auth: AuthContext) {
    const canonical = this.resolveWorkspacePath(path)
    let tracked = false
    for (const prior of this.state.leases) {
      if (prior.workspacePath !== canonical) continue
      tracked = true
      if (prior.subject !== auth.subject) {
        this.audit('workspace_lease_subject_rejected', auth, {
          leaseId: prior.leaseId,
          workspacePath: canonical,
          priorSessionHash: prior.sessionHash,
        })
        throw new Error('workspace belongs to another authenticated subject')
      }
      if (prior.status === 'active' && Date.now() >= parseTime(prior.expiresAt)) {
        this.expire(prior, auth, 'lease_expired_before_reacquisition')
      }
      if (
        prior.activeJobIds.length > 0 &&
        !(prior.status === 'quarantined' && isConfinementFailedReason(prior.reason))
      ) {
        throw new Error(`workspace lease is invalidated but still terminating active jobs: ${canonical}`)
      }
      if (prior.status === 'active' && prior.bootId === this.bootId) {
        throw new Error(`workspace is already leased by another session: ${canonical}`)
      }
    }
    if (!tracked) {
      const stat = lstatSync(canonical)
      const effectiveUid = process.geteuid?.() ?? stat.uid
      if (stat.uid !== effectiveUid || (stat.mode & 0o022) !== 0) {
        throw new Error(`untracked workspace must be owned exclusively by the agents-shell server: ${canonical}`)
      }
    }
    sealTree(canonical)
    return canonical
  }

  private validateWorkspace(path: string) {
    const canonical = this.resolveWorkspacePath(path)
    const topLevel = realpathSync(this.git(['rev-parse', '--show-toplevel'], canonical))
    if (topLevel !== canonical) throw new Error(`workspace must be a repository root: ${canonical}`)
    const gitDirectoryRaw = this.git(['rev-parse', '--absolute-git-dir'], canonical)
    const gitDirectory = realpathSync(gitDirectoryRaw)
    const gitCommonRaw = this.git(['rev-parse', '--git-common-dir'], canonical)
    const gitCommon = realpathSync(isAbsolute(gitCommonRaw) ? gitCommonRaw : resolve(canonical, gitCommonRaw))
    if (!isInsidePath(canonical, gitDirectory) || !isInsidePath(canonical, gitCommon)) {
      throw new Error(`workspace Git metadata must stay inside the leased repository: ${canonical}`)
    }
    assertNoHardlinks(canonical)
    return canonical
  }

  private newWorkspace(task: string) {
    const slug = safeTaskSlug(task)
    const suffix = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    const directoryName = `${slug}-${suffix}`
    const workspacePath = resolve(this.config.workspaceLeaseRoot, directoryName)
    if (existsSync(workspacePath)) throw new Error(`generated workspace already exists: ${workspacePath}`)
    const branch = `codex/${directoryName}`
    return { workspacePath, branch }
  }

  private async createWorkspace(
    generated: { workspacePath: string; branch: string },
    baseRef: string,
    expectedCommit?: string,
  ) {
    const { workspacePath, branch } = generated
    try {
      this.git(['clone', '--no-hardlinks', '--no-checkout', this.config.workspaceSeedPath, workspacePath])
      sealTree(workspacePath)
      const remoteUrl = this.git(['remote', 'get-url', 'origin'], this.config.workspaceSeedPath)
      this.git(['remote', 'set-url', 'origin', remoteUrl], workspacePath)
      const selectedBase = this.selectedBase(baseRef)
      if (selectedBase.remoteBranch && selectedBase.remoteTrackingRef) {
        await this.gitAsync(
          [
            'fetch',
            '--no-tags',
            '--upload-pack=git-upload-pack',
            'origin',
            `+${selectedBase.remoteBranch}:${selectedBase.remoteTrackingRef}`,
          ],
          workspacePath,
          serverOwnedRemoteConfig(remoteUrl),
        )
      }
      const head = this.git(['rev-parse', `${selectedBase.resolveRef}^{commit}`], workspacePath)
      if (expectedCommit && head !== expectedCommit) {
        throw new Error(`workspace base mismatch: expected ${expectedCommit}, got ${head}`)
      }
      this.git(['checkout', '-b', branch, head], workspacePath)
      this.git(['config', 'user.name', process.env.AGENTS_SHELL_GIT_USER_NAME ?? 'Greg Konush'], workspacePath)
      this.git(['config', 'user.email', process.env.AGENTS_SHELL_GIT_USER_EMAIL ?? 'greg@proompteng.ai'], workspacePath)
      if (!this.isClean(workspacePath)) throw new Error('new workspace is not clean')
      const canonical = this.validateWorkspace(workspacePath)
      return { workspacePath: canonical, branch, head, publicationRefs: this.localPublicationRefs(canonical) }
    } catch (error) {
      rmSync(workspacePath, { recursive: true, force: true })
      throw error
    }
  }

  private async recoverPriorLeaseForPath(path: string, auth: AuthContext) {
    let created = false
    let publicationHead: string | null = null
    let publicationRefs: Record<string, string> | null = null
    for (const prior of this.state.leases) {
      if (prior.workspacePath !== path) continue
      created ||= prior.created
      if (prior.created) {
        if (publicationHead != null && publicationHead !== prior.publicationHead) {
          throw new Error(`workspace has inconsistent publication history: ${path}`)
        }
        publicationHead = prior.publicationHead
        if (publicationRefs != null && !publicationRefsEqual(publicationRefs, prior.publicationRefs)) {
          throw new Error(`workspace has inconsistent publication ref history: ${path}`)
        }
        publicationRefs = prior.publicationRefs
      }
      let confinementCompleted = false
      if (prior.subject !== auth.subject) {
        this.audit('workspace_lease_subject_rejected', auth, {
          leaseId: prior.leaseId,
          workspacePath: path,
          priorSessionHash: prior.sessionHash,
        })
        throw new Error('workspace belongs to another authenticated subject')
      }
      if (prior.status === 'active' && Date.now() >= parseTime(prior.expiresAt)) {
        this.expire(prior, auth, 'lease_expired_before_reacquisition')
      }
      if (prior.status === 'quarantined') {
        if (prior.reason === PUBLICATION_CHECK_FAILED_REASON) {
          let publicationError: unknown = null
          let publicationProven = false
          let headAtRetry: string | null = null
          try {
            const publication = await this.createdWorkspacePublication(prior)
            publicationProven = publication.publicationProven
            headAtRetry = publication.head
          } catch (error) {
            publicationError = error
          }
          this.audit('workspace_lease_publication_retried', auth, {
            leaseId: prior.leaseId,
            workspacePath: path,
            publicationCheckCompleted: publicationError == null,
            publicationProven,
            headAtRetry,
          })
          if (publicationError) throw publicationError
          if (!publicationProven) {
            prior.reason = 'unpublished_commits'
            this.persist()
            throw new Error(`workspace still contains unpublished commits: ${path}`)
          }
          confinementCompleted = true
        } else if (isConfinementFailedReason(prior.reason)) {
          const retryError = this.finishConfinement(prior, 'orphaned', 'reacquisition_confinement_retry')
          this.audit('workspace_lease_confinement_retried', auth, {
            leaseId: prior.leaseId,
            workspacePath: path,
            confinementCompleted: retryError == null,
          })
          if (retryError) throw retryError
          confinementCompleted = true
        } else {
          throw new Error(`workspace is quarantined after prior lease loss: ${path}`)
        }
      }
      if (prior.status === 'active' && prior.bootId === this.bootId) {
        throw new Error(`workspace is already leased by another session: ${path}`)
      }
      if (prior.activeJobIds.length > 0) {
        throw new Error(`workspace lease is invalidated but still terminating active jobs: ${path}`)
      }
      if (prior.status === 'released') {
        try {
          rmSync(this.runtimePath(prior), { recursive: true, force: true })
        } catch (error) {
          prior.status = 'quarantined'
          prior.reason = 'recovery_runtime_cleanup_failed'
          this.persist()
          throw error
        }
        continue
      }
      if (!confinementCompleted) {
        const confinementError = this.finishConfinement(
          prior,
          prior.status === 'revoked' ? 'revoked' : 'orphaned',
          'reacquisition_confinement_retry',
        )
        if (confinementError) throw confinementError
      }
      if (!this.isClean(path)) {
        prior.status = 'quarantined'
        prior.reason = 'dirty_after_lease_loss'
        this.persist()
        this.audit('workspace_lease_quarantined', auth, {
          leaseId: prior.leaseId,
          workspacePath: path,
          reason: prior.reason,
        })
        throw new Error(`workspace is dirty after lease loss and is quarantined: ${path}`)
      }
      try {
        rmSync(this.runtimePath(prior), { recursive: true, force: true })
      } catch (error) {
        prior.status = 'quarantined'
        prior.reason = 'recovery_runtime_cleanup_failed'
        this.persist()
        this.audit('workspace_lease_quarantined', auth, {
          leaseId: prior.leaseId,
          workspacePath: path,
          reason: prior.reason,
        })
        throw error
      }
      prior.status = 'released'
      prior.reason = 'clean_recovery'
      prior.activeJobIds = []
      this.persist()
      this.audit('workspace_lease_recovered', auth, {
        leaseId: prior.leaseId,
        workspacePath: path,
        reason: prior.reason,
        runtimeRemoved: true,
      })
    }
    return { created, publicationHead, publicationRefs }
  }

  async acquire(sessionId: string, auth: AuthContext, input: WorkspaceAcquireInput) {
    const existingLeaseId = this.bySession.get(sessionId)
    const existing = existingLeaseId ? this.state.leases.find((lease) => lease.leaseId === existingLeaseId) : undefined
    if (existing?.status === 'active' && Date.now() < parseTime(existing.expiresAt)) {
      return this.renewActiveLease(existing, auth)
    }

    const canonicalExistingPath = input.existingPath ? this.resolveWorkspacePath(input.existingPath) : null
    const generated = canonicalExistingPath ? null : this.newWorkspace(input.task)
    const operationPath = canonicalExistingPath ?? generated!.workspacePath
    return await this.withWorkspaceOperation(operationPath, () =>
      this.acquireSerialized(
        sessionId,
        auth,
        canonicalExistingPath ? { ...input, existingPath: canonicalExistingPath } : input,
        generated,
      ),
    )
  }

  private async acquireSerialized(
    sessionId: string,
    auth: AuthContext,
    input: WorkspaceAcquireInput,
    generated: { workspacePath: string; branch: string } | null,
  ) {
    if (sessionId.startsWith('ephemeral:')) throw new Error('workspace acquisition requires a persistent MCP session')
    const existingLeaseId = this.bySession.get(sessionId)
    if (existingLeaseId) {
      const existing = this.state.leases.find((lease) => lease.leaseId === existingLeaseId)
      if (existing?.status === 'active' && Date.now() >= parseTime(existing.expiresAt)) {
        this.expire(existing, auth, 'lease_expired_before_reacquisition')
        this.bySession.delete(sessionId)
      }
      if (existing?.status === 'active') return this.renewActiveLease(existing, auth)
    }

    const baseRef = input.baseRef ?? 'origin/main'
    let created = false
    let publicationHead: string | null = null
    let workspace: { workspacePath: string; branch: string; head: string; publicationRefs: Record<string, string> }
    if (input.existingPath) {
      const workspacePath = this.validateWorkspace(this.prepareExistingWorkspace(input.existingPath, auth))
      const recovery = await this.recoverPriorLeaseForPath(workspacePath, auth)
      created = recovery.created
      publicationHead = recovery.publicationHead
      if (!this.isClean(workspacePath)) throw new Error(`existing workspace must be clean: ${workspacePath}`)
      workspace = {
        workspacePath,
        branch: this.git(['branch', '--show-current'], workspacePath),
        head: this.git(['rev-parse', 'HEAD'], workspacePath),
        publicationRefs: recovery.publicationRefs ?? {},
      }
      if (input.expectedCommit && workspace.head !== input.expectedCommit) {
        throw new Error(`workspace base mismatch: expected ${input.expectedCommit}, got ${workspace.head}`)
      }
    } else {
      if (!generated) throw new Error('generated workspace metadata is required')
      workspace = await this.createWorkspace(generated, baseRef, input.expectedCommit)
      created = true
    }

    let runtime: string | null = null
    let pendingLease: WorkspaceLease | null = null
    let leasePersisted = false
    let nextUidBeforeAllocation: number | null = null
    try {
      const now = Date.now()
      const expiresAt = this.expiryForAuth(auth, now)
      const stat = statSync(workspace.workspacePath)
      if (!this.uidAllocator) nextUidBeforeAllocation = this.state.nextUid
      const uid = this.allocateUid()
      const lease: WorkspaceLease = {
        leaseId: randomUUID(),
        sessionHash: sessionIdentityHash(sessionId),
        subject: auth.subject,
        workspacePath: workspace.workspacePath,
        branch: workspace.branch,
        head: workspace.head,
        publicationHead: publicationHead ?? workspace.head,
        publicationRefs: workspace.publicationRefs,
        device: stat.dev,
        inode: stat.ino,
        uid,
        gid: uid,
        issuedAt: iso(now),
        renewedAt: iso(now),
        expiresAt: iso(expiresAt),
        status: 'active',
        bootId: this.bootId,
        activeJobIds: [],
        reason: null,
        created,
      }
      pendingLease = lease
      runtime = this.runtimePath(lease)
      mkdirSync(runtime, { recursive: true, mode: 0o700 })
      chownTree(workspace.workspacePath, lease.uid, lease.gid)
      chownTree(runtime, lease.uid, lease.gid)

      this.state.leases.push(lease)
      this.bySession.set(sessionId, lease.leaseId)
      this.persist()
      leasePersisted = true
      try {
        this.audit('workspace_lease_acquired', auth, {
          leaseId: lease.leaseId,
          sessionHash: lease.sessionHash,
          workspacePath: lease.workspacePath,
          branch: lease.branch,
          head: lease.head,
          uid: lease.uid,
          expiresAt: lease.expiresAt,
          created,
        })
      } catch (error) {
        this.invalidateWithoutAudit(lease, 'audit_persistence_failed')
        throw error
      }
      this.scheduleExpiry(lease)
      return this.publicLease(lease)
    } catch (error) {
      if (!leasePersisted) {
        let rollbackError: unknown = null
        let stagedLeaseRemoved = false
        if (pendingLease) {
          stagedLeaseRemoved = this.state.leases.some((candidate) => candidate.leaseId === pendingLease?.leaseId)
          this.state.leases = this.state.leases.filter((candidate) => candidate.leaseId !== pendingLease?.leaseId)
          if (this.bySession.get(sessionId) === pendingLease.leaseId) this.bySession.delete(sessionId)
          if (nextUidBeforeAllocation != null) this.state.nextUid = nextUidBeforeAllocation
        }
        if (stagedLeaseRemoved) {
          try {
            this.persist()
          } catch (cleanupError) {
            rollbackError = cleanupError
          }
        }
        try {
          if (runtime) rmSync(runtime, { recursive: true, force: true })
        } catch (cleanupError) {
          rollbackError ??= cleanupError
        }
        try {
          if (created) rmSync(workspace.workspacePath, { recursive: true, force: true })
          else sealTree(workspace.workspacePath)
        } catch (cleanupError) {
          rollbackError ??= cleanupError
        }
        if (rollbackError) {
          throw new AggregateError([error, rollbackError], 'workspace acquisition failed and rollback was incomplete')
        }
      }
      throw error
    }
  }

  private publicLease(lease: WorkspaceLease) {
    return {
      leaseId: lease.leaseId,
      workspacePath: lease.workspacePath,
      branch: lease.branch,
      head: lease.head,
      issuedAt: lease.issuedAt,
      renewedAt: lease.renewedAt,
      expiresAt: lease.expiresAt,
      status: lease.status,
    }
  }

  status(sessionId: string, auth: AuthContext) {
    const lease = this.ownedLease(sessionId)
    if (!lease) return { lease: null }
    if (lease.status === 'active' && Date.now() >= parseTime(lease.expiresAt)) {
      this.expire(lease, auth, 'lease_expired')
    }
    return { lease: this.publicLease(lease) }
  }

  requireActive(sessionId: string, auth: AuthContext, cwd?: string | null) {
    const lease = this.ownedLease(sessionId)
    if (!lease || lease.status !== 'active') throw new Error('an active workspace lease is required')
    if (lease.subject !== auth.subject || lease.sessionHash !== sessionIdentityHash(sessionId)) {
      this.audit('workspace_lease_identity_rejected', auth, {
        leaseId: lease.leaseId,
        sessionHash: sessionIdentityHash(sessionId),
      })
      throw new Error('workspace lease identity mismatch')
    }
    if (Date.now() >= parseTime(lease.expiresAt)) {
      this.expire(lease, auth, 'lease_expired')
      throw new Error('workspace lease has expired')
    }

    const canonicalRoot = realpathSync(lease.workspacePath)
    const rootStat = statSync(canonicalRoot)
    if (canonicalRoot !== lease.workspacePath || rootStat.dev !== lease.device || rootStat.ino !== lease.inode) {
      this.revokeLease(lease, auth, 'workspace_identity_changed')
      throw new Error('workspace path or inode changed after lease acquisition')
    }
    const candidate = cwd ? (isAbsolute(cwd) ? resolve(cwd) : resolve(canonicalRoot, cwd)) : canonicalRoot
    if (!existsSync(candidate)) throw new Error(`cwd does not exist: ${candidate}`)
    const canonicalCwd = realpathSync(candidate)
    if (!isInsidePath(canonicalRoot, canonicalCwd)) {
      this.audit('workspace_lease_path_rejected', auth, {
        leaseId: lease.leaseId,
        cwd: candidate,
        canonicalCwd,
      })
      throw new Error(`mutation cwd must stay under leased workspace: ${canonicalRoot}`)
    }
    return { lease, cwd: canonicalCwd, runtimePath: this.runtimePath(lease) }
  }

  inspectionContext(sessionId: string, auth: AuthContext, cwd?: string | null) {
    let lease = this.ownedLease(sessionId)
    if (lease?.status === 'active' && Date.now() >= parseTime(lease.expiresAt)) {
      this.expire(lease, auth, 'lease_expired_before_inspection')
      lease = null
    }
    if (lease?.status === 'active') {
      if (lease.subject !== auth.subject || lease.sessionHash !== sessionIdentityHash(sessionId)) {
        this.audit('workspace_lease_identity_rejected', auth, {
          leaseId: lease.leaseId,
          sessionHash: sessionIdentityHash(sessionId),
        })
        throw new Error('workspace lease identity mismatch')
      }
    } else {
      lease = null
    }
    const defaultRoot = lease?.status === 'active' ? lease.workspacePath : this.config.workspaceSeedPath
    const candidate = cwd ? (isAbsolute(cwd) ? resolve(cwd) : resolve(defaultRoot, cwd)) : defaultRoot
    if (!existsSync(candidate)) throw new Error(`cwd does not exist: ${candidate}`)
    const canonical = realpathSync(candidate)
    const seed = realpathSync(this.config.workspaceSeedPath)
    if (canonical === seed || isInsidePath(seed, canonical)) {
      return { cwd: canonical, lease, repositoryRoot: seed }
    }
    if (lease && (canonical === lease.workspacePath || isInsidePath(lease.workspacePath, canonical))) {
      return { cwd: canonical, lease, repositoryRoot: lease.workspacePath }
    }
    throw new Error('read path must stay under the shared seed or the current session workspace')
  }

  resolveInspectionCwd(sessionId: string, auth: AuthContext, cwd?: string | null) {
    return this.inspectionContext(sessionId, auth, cwd).cwd
  }

  resolveReadablePath(sessionId: string, auth: AuthContext, path: string) {
    const context = this.inspectionContext(sessionId, auth)
    const base = context.lease?.workspacePath ?? this.config.workspaceSeedPath
    const candidate = isAbsolute(path) ? resolve(path) : resolve(base, path)
    if (!existsSync(candidate)) throw new Error(`path does not exist: ${candidate}`)
    const canonical = realpathSync(candidate)
    this.inspectionContext(sessionId, auth, canonical)
    return canonical
  }

  validateMutationPaths(sessionId: string, auth: AuthContext, cwd: string | null | undefined, paths: string[]) {
    const active = this.requireActive(sessionId, auth, cwd)
    for (const path of paths) {
      if (isAbsolute(path)) throw new Error(`mutation path must be relative to the leased workspace: ${path}`)
      const candidate = resolve(active.cwd, path)
      if (!isInsidePath(active.lease.workspacePath, candidate)) {
        throw new Error(`mutation path must stay under leased workspace: ${path}`)
      }
      const ancestor = realpathSync(nearestExistingAncestor(candidate))
      if (!isInsidePath(active.lease.workspacePath, ancestor)) {
        throw new Error(`mutation path resolves outside leased workspace: ${path}`)
      }
      if (existsSync(candidate)) {
        const canonical = realpathSync(candidate)
        if (!isInsidePath(active.lease.workspacePath, canonical)) {
          throw new Error(`mutation path resolves outside leased workspace: ${path}`)
        }
      }
    }
    return active
  }

  private runtimePath(lease: WorkspaceLease) {
    return resolve(this.config.sessionRuntimeRoot, lease.leaseId)
  }

  private openLeaseRuntimeDirectory(path: string, label: string) {
    try {
      const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
      if (!fstatSync(fd).isDirectory()) {
        closeSync(fd)
        throw new Error(`${label} must be a directory`)
      }
      return fd
    } catch (error) {
      throw new Error(`${label} must be a non-symlink directory`, { cause: error })
    }
  }

  private prepareLeaseRuntimeDirectory(runtimeFd: number, name: string, lease: WorkspaceLease) {
    const descriptorPath = `/proc/self/fd/${runtimeFd}/${name}`
    try {
      mkdirSync(descriptorPath, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const fd = this.openLeaseRuntimeDirectory(descriptorPath, `lease runtime component ${name}`)
    try {
      let stat = fstatSync(fd)
      if ((stat.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700)
      if (stat.uid !== lease.uid || stat.gid !== lease.gid) {
        fchownSync(fd, lease.uid, lease.gid)
      }
      stat = fstatSync(fd)
      if (stat.uid !== lease.uid || stat.gid !== lease.gid || (stat.mode & 0o777) !== 0o700) {
        throw new Error(`lease runtime component ${name} metadata does not match the lease identity`)
      }
    } catch (error) {
      closeSync(fd)
      throw error
    }
    return fd
  }

  private prepareLeaseGitConfig(configFd: number, lease: WorkspaceLease) {
    const descriptorPath = `/proc/self/fd/${configFd}/gitconfig`
    let fd: number
    let created = false
    try {
      fd = openSync(
        descriptorPath,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      )
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error('lease Git config must be a non-symlink regular file', { cause: error })
      }
      try {
        fd = openSync(descriptorPath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW)
      } catch (openError) {
        throw new Error('lease Git config must be a non-symlink regular file', { cause: openError })
      }
    }

    try {
      let stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error('lease Git config must be an unlinked regular file')
      }
      if (created) {
        writeFileSync(
          fd,
          `[user]\n\tname = ${process.env.AGENTS_SHELL_GIT_USER_NAME ?? 'Greg Konush'}\n\temail = ${process.env.AGENTS_SHELL_GIT_USER_EMAIL ?? 'greg@proompteng.ai'}\n[init]\n\tdefaultBranch = main\n[safe]\n\tdirectory = ${lease.workspacePath}\n[credential "https://github.com"]\n\thelper = !gh auth git-credential\n`,
          'utf8',
        )
        fsyncSync(fd)
      }
      if ((stat.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600)
      if (stat.uid !== lease.uid || stat.gid !== lease.gid) {
        fchownSync(fd, lease.uid, lease.gid)
      }
      stat = fstatSync(fd)
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== lease.uid ||
        stat.gid !== lease.gid ||
        (stat.mode & 0o777) !== 0o600
      ) {
        throw new Error('lease Git config metadata does not match the lease identity')
      }
    } finally {
      closeSync(fd)
    }
  }

  environment(lease: WorkspaceLease) {
    const runtime = this.runtimePath(lease)
    const home = join(runtime, 'home')
    const tmp = join(runtime, 'tmp')
    const cache = join(runtime, 'cache')
    const config = join(runtime, 'config')
    const runtimeFd = this.openLeaseRuntimeDirectory(runtime, 'lease runtime root')
    let configFd: number | null = null
    try {
      for (const name of ['home', 'tmp', 'cache', 'config'] as const) {
        const fd = this.prepareLeaseRuntimeDirectory(runtimeFd, name, lease)
        if (name === 'config') configFd = fd
        else closeSync(fd)
      }
      if (configFd == null) throw new Error('lease runtime config directory was not prepared')
      this.prepareLeaseGitConfig(configFd, lease)
    } finally {
      if (configFd != null) closeSync(configFd)
      closeSync(runtimeFd)
    }
    const gitConfig = join(config, 'gitconfig')
    return {
      ...sanitizedProcessEnv(process.env),
      HOME: home,
      TMPDIR: tmp,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: config,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      PATH: trustedPathValue(this.config.trustedExecutables),
      TERM: process.env.TERM ?? 'dumb',
    }
  }

  inspectionEnvironment(lease: WorkspaceLease | null, cwd: string) {
    const seed = realpathSync(this.config.workspaceSeedPath)
    const safeDirectory =
      lease && (cwd === lease.workspacePath || isInsidePath(lease.workspacePath, cwd)) ? lease.workspacePath : seed
    return {
      ...inClusterDiscoveryEnvironment(process.env),
      HOME: '/nonexistent',
      KUBECONFIG: '/dev/null',
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_VALUE_0: safeDirectory,
      PATH: trustedPathValue(this.config.trustedExecutables),
      TERM: process.env.TERM ?? 'dumb',
    }
  }

  confinementArgs(
    lease: WorkspaceLease | null,
    executable: string,
    args: string[],
    writable: boolean,
    readOnlyScratchRoot?: string,
    cwdFd = 3,
  ) {
    const uid = lease?.uid ?? this.config.inspectionUid
    const gid = lease?.gid ?? this.config.inspectionGid
    const confinementArgs = [
      '--uid',
      String(uid),
      '--gid',
      String(gid),
      '--parent-pid',
      String(process.pid),
      '--cwd-fd',
      String(cwdFd),
    ]
    if (writable) {
      if (!lease) throw new Error('writable confinement requires a workspace lease')
      if (readOnlyScratchRoot) throw new Error('writable confinement rejects a read-only scratch root')
      confinementArgs.push(
        '--write-root',
        lease.workspacePath,
        '--write-root',
        this.runtimePath(lease),
        '--write-file',
        '/dev/null',
      )
    } else {
      if (readOnlyScratchRoot) confinementArgs.push('--write-root', readOnlyScratchRoot)
      confinementArgs.push('--read-only')
    }
    return [...confinementArgs, '--', executable, ...args]
  }

  bindJob(lease: WorkspaceLease, jobId: string, auth: AuthContext) {
    if (!lease.activeJobIds.includes(jobId)) lease.activeJobIds.push(jobId)
    this.persist()
    try {
      this.audit('workspace_lease_job_bound', auth, { leaseId: lease.leaseId, jobId })
    } catch (error) {
      this.invalidateWithoutAudit(lease, 'audit_persistence_failed')
      throw error
    }
  }

  unbindJob(leaseId: string, jobId: string, auth: AuthContext) {
    const lease = this.state.leases.find((candidate) => candidate.leaseId === leaseId)
    if (!lease) return
    lease.activeJobIds = lease.activeJobIds.filter((candidate) => candidate !== jobId)
    this.persist()
    this.audit('workspace_lease_job_unbound', auth, { leaseId, jobId })
  }

  async release(sessionId: string, auth: AuthContext, reason = 'session_release') {
    const lease = this.ownedLease(sessionId)
    if (!lease) return { lease: null }
    return await this.withWorkspaceOperation(lease.workspacePath, () => this.releaseSerialized(sessionId, auth, reason))
  }

  private async releaseSerialized(sessionId: string, auth: AuthContext, reason: string) {
    const lease = this.ownedLease(sessionId)
    if (!lease) return { lease: null }
    if (lease.status !== 'active') return { lease: this.publicLease(lease) }
    if (lease.activeJobIds.length > 0) throw new Error('cannot release a workspace lease with active jobs')
    this.clearExpiryTimer(lease.leaseId)
    const confinementError = this.finishConfinement(lease, 'orphaned', reason)
    let cleanlinessError: unknown = null
    let publicationError: unknown = null
    let cleanupError: unknown = null
    let runtimeRemoved = false
    let workspaceRemoved = false
    let clean = false
    let headAtRelease: string | null = null
    let headAdvanced = false
    let publicationProven = false
    if (confinementError == null) {
      try {
        clean = this.isClean(lease.workspacePath)
      } catch (error) {
        cleanlinessError = error
      }
    }
    if (clean) {
      if (lease.created) {
        try {
          const publication = await this.createdWorkspacePublication(lease)
          headAtRelease = publication.head
          headAdvanced = publication.headAdvanced
          publicationProven = publication.publicationProven
        } catch (error) {
          publicationError = error
        }
      }
      if (!lease.created || publicationProven) {
        try {
          rmSync(this.runtimePath(lease), { recursive: true, force: true })
          runtimeRemoved = true
          if (lease.created) {
            rmSync(lease.workspacePath, { recursive: true, force: true })
            workspaceRemoved = true
          }
        } catch (error) {
          cleanupError = error
        }
      }
    }
    const retainedUnpublishedClone = clean && lease.created && !publicationProven
    lease.status = clean && !retainedUnpublishedClone && cleanupError == null ? 'released' : 'quarantined'
    lease.reason =
      clean && !retainedUnpublishedClone && cleanupError == null
        ? reason
        : confinementError
          ? confinementFailedReason(reason)
          : cleanlinessError
            ? 'release_git_inspection_failed'
            : publicationError
              ? PUBLICATION_CHECK_FAILED_REASON
              : retainedUnpublishedClone
                ? 'unpublished_commits'
                : cleanupError
                  ? 'release_cleanup_failed'
                  : 'dirty_on_release'
    this.bySession.delete(sessionId)
    const releasedLease = this.publicLease(lease)
    this.persist()
    this.audit('workspace_lease_released', auth, {
      leaseId: lease.leaseId,
      workspacePath: lease.workspacePath,
      status: lease.status,
      reason: lease.reason,
      confinementCompleted: confinementError == null,
      gitInspectionCompleted: cleanlinessError == null,
      publicationCheckCompleted: publicationError == null,
      publicationProven,
      headAtRelease,
      headAdvanced,
      runtimeRemoved,
      workspaceRemoved,
    })
    if (lease.status === 'released' && workspaceRemoved) {
      this.state.leases = this.state.leases.filter((candidate) => candidate.leaseId !== lease.leaseId)
      this.persist()
    } else if (lease.status === 'released' && !lease.created && runtimeRemoved) {
      this.state.leases = this.state.leases.filter(
        (candidate) =>
          candidate.leaseId === lease.leaseId ||
          candidate.workspacePath !== lease.workspacePath ||
          candidate.subject !== lease.subject ||
          candidate.status !== 'released',
      )
      this.persist()
    }
    if (confinementError) throw confinementError
    if (cleanlinessError) throw cleanlinessError
    if (cleanupError) throw cleanupError
    return { lease: releasedLease }
  }

  revokeSession(sessionId: string, auth: AuthContext | null, reason: string) {
    const lease = this.ownedLease(sessionId)
    if (!lease) return null
    this.revokeLease(lease, auth, reason)
    this.bySession.delete(sessionId)
    return lease
  }

  findById(leaseId: string) {
    return this.state.leases.find((candidate) => candidate.leaseId === leaseId) ?? null
  }

  revokeById(leaseId: string, auth: AuthContext | null, reason: string) {
    const lease = this.findById(leaseId)
    if (!lease || lease.status !== 'active') return lease
    this.revokeLease(lease, auth, reason)
    for (const [sessionId, candidateLeaseId] of this.bySession) {
      if (candidateLeaseId === leaseId) this.bySession.delete(sessionId)
    }
    return lease
  }

  expireById(leaseId: string, auth: AuthContext | null, reason: string) {
    const lease = this.findById(leaseId)
    if (!lease || lease.status !== 'active') return lease
    this.expire(lease, auth, reason)
    for (const [sessionId, candidateLeaseId] of this.bySession) {
      if (candidateLeaseId === leaseId) this.bySession.delete(sessionId)
    }
    return lease
  }

  private revokeLease(lease: WorkspaceLease, auth: AuthContext | null, reason: string) {
    this.clearExpiryTimer(lease.leaseId)
    lease.status = 'revoked'
    lease.reason = reason
    this.persist()
    const confinementError = this.finishConfinement(lease, 'revoked', reason)
    this.audit('workspace_lease_revoked', auth, {
      leaseId: lease.leaseId,
      workspacePath: lease.workspacePath,
      reason,
      confinementCompleted: confinementError == null,
    })
    if (confinementError) throw confinementError
  }

  private expire(lease: WorkspaceLease, auth: AuthContext | null, reason: string) {
    this.clearExpiryTimer(lease.leaseId)
    lease.status = 'expired'
    lease.reason = reason
    this.persist()
    const confinementError = this.finishConfinement(lease, 'expired', reason)
    this.audit('workspace_lease_expired', auth, {
      leaseId: lease.leaseId,
      workspacePath: lease.workspacePath,
      reason,
      confinementCompleted: confinementError == null,
    })
    if (confinementError) throw confinementError
  }

  ownedLease(sessionId: string) {
    const leaseId = this.bySession.get(sessionId)
    return leaseId ? (this.state.leases.find((candidate) => candidate.leaseId === leaseId) ?? null) : null
  }

  shutdown() {
    for (const child of this.activePrivilegedGitProcesses) this.killPrivilegedGitProcess(child)
    this.activePrivilegedGitProcesses.clear()
    for (const timer of this.expiryTimers.values()) clearTimeout(timer)
    this.expiryTimers.clear()
    const orphaned: WorkspaceLease[] = []
    for (const lease of this.state.leases) {
      if (lease.status !== 'active' || lease.bootId !== this.bootId) continue
      lease.status = 'orphaned'
      lease.reason = 'server_shutdown'
      orphaned.push(lease)
    }
    if (orphaned.length > 0) {
      this.persist()
      for (const lease of orphaned) {
        const confinementError = this.finishConfinement(lease, 'orphaned', 'server_shutdown')
        this.audit('workspace_lease_shutdown_orphaned', null, {
          leaseId: lease.leaseId,
          workspacePath: lease.workspacePath,
          bootId: this.bootId,
          confinementCompleted: confinementError == null,
        })
        if (confinementError) throw confinementError
      }
    }
    this.bySession.clear()
  }
}
