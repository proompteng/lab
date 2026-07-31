import { randomUUID } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync } from 'node:fs'
import { relative, sep } from 'node:path'

import { Effect } from 'effect'

import { writeAuditLog } from './audit'
import type { AuthContext } from './auth'
import type { AgentsShellConfig } from './config'
import { ShellJobStore, appendTail, tail, type CommandInput, type ShellJob } from './jobs'
import { asPositiveInteger } from './limits'
import { formatCommand, toProcessResult, type ProcessResult } from './process-runner'
import { processIdsForUid as linuxProcessIdsForUid, terminateProcessesForUid } from './process-isolation'
import { trustedExecutablePath, trustedPathValue, type TrustedExecutableName } from './trusted-executables'
import { WorkspaceLeaseManager, type WorkspaceAcquireInput, type WorkspaceLease } from './workspace-leases'

type ProcessOptions = {
  command: TrustedExecutableName
  args: string[]
  cwd?: string
  stdin?: string
  timeoutSeconds?: number
  maxOutputBytes?: number
  okExitCodes?: number[]
  auth: AuthContext
  auditEvent: string
  sessionId: string
  mutation?: boolean
  readOnlyGitConfigPath?: string
  readOnlyGitIndexPath?: string
  readOnlyScratchRoot?: string
}

type ActiveMutationProcess = {
  id: string
  sessionId: string
  leaseId: string
  child: ChildProcess
}

type AgentsShellRunnerOptions = {
  uidAllocator?: () => number
  terminateProcessesForUid?: (uid: number) => number[]
  processIdsForUid?: (uid: number) => number[]
}

type ReadOnlyGitInspectionContext = {
  cwd: string
  configOverrides: string[]
  gitConfigPath: string
  gitHooksPath: string
  gitIndexPath: string
  scratchRoot: string
}

const CHILD_CWD_FD = 3

const openPinnedCwd = (root: string, cwd: string) => {
  const relativeCwd = relative(root, cwd)
  if (relativeCwd === '..' || relativeCwd.startsWith(`..${sep}`)) {
    throw new Error(`process cwd must stay under its validated root: ${root}`)
  }
  let fd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
  try {
    if (!fstatSync(fd).isDirectory()) throw new Error(`process cwd must be a directory: ${cwd}`)
    if (!relativeCwd) return fd
    for (const component of relativeCwd.split(sep)) {
      if (!component || component === '.' || component === '..') {
        throw new Error(`process cwd contains an invalid component: ${cwd}`)
      }
      const nextFd = openSync(
        `/proc/self/fd/${fd}/${component}`,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      )
      closeSync(fd)
      fd = nextFd
      if (!fstatSync(fd).isDirectory()) throw new Error(`process cwd must be a directory: ${cwd}`)
    }
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

const killDetachedProcess = (child: ChildProcess, signal: NodeJS.Signals) => {
  const pid = child.pid
  if (!pid) return false
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return child.kill(signal)
  }
}

export class AgentsShellRunner {
  readonly config: AgentsShellConfig
  readonly jobs = new ShellJobStore()
  readonly leases: WorkspaceLeaseManager
  readonly confinementStatus: { landlock: string }
  private readonly activeMutationProcesses = new Map<string, ActiveMutationProcess>()
  private readonly processTerminator: ((uid: number) => number[]) | null
  private readonly processInspector: (uid: number) => number[]
  private readonly gitInspectionLeases = new Set<string>()

  constructor(config: AgentsShellConfig, options: AgentsShellRunnerOptions = {}) {
    this.config = config
    this.processTerminator = options.terminateProcessesForUid ?? null
    this.processInspector =
      options.processIdsForUid ?? ((uid) => (uid === (process.geteuid?.() ?? -1) ? [] : linuxProcessIdsForUid(uid)))
    mkdirSync(config.workspaceRoot, { recursive: true })
    this.leases = new WorkspaceLeaseManager(config, {
      uidAllocator: options.uidAllocator,
      onLeaseInvalidated: (lease) => this.terminateLeaseProcesses(lease),
    })
    this.confinementStatus = this.assertConfinementAvailable()
  }

  private terminateLeaseProcesses(lease: WorkspaceLease) {
    for (const job of this.runningJobs()) {
      if (job.leaseId !== lease.leaseId) continue
      job.status = 'killed'
      job.signal = 'SIGKILL'
      this.killProcessGroup(job, 'SIGKILL')
    }
    for (const active of this.activeMutationProcesses.values()) {
      if (active.leaseId !== lease.leaseId) continue
      killDetachedProcess(active.child, 'SIGKILL')
    }
    if (this.processTerminator) {
      this.processTerminator(lease.uid)
    } else if (lease.uid !== (process.geteuid?.() ?? -1)) {
      terminateProcessesForUid(lease.uid)
    }
  }

  private revokeAfterAuditFailure(leaseId: string, auth: AuthContext | null) {
    try {
      this.leases.revokeById(leaseId, auth, 'audit_persistence_failed')
    } catch {
      // revokeById persists the fail-closed state before attempting its own durable audit.
    }
  }

  private assertMutationAllowed(lease: WorkspaceLease) {
    if (this.gitInspectionLeases.has(lease.leaseId)) {
      throw new Error('workspace mutation is blocked during read-only Git inspection')
    }
  }

  private assertLeaseGitInspectionQuiescent(lease: WorkspaceLease) {
    const tracked = new Set<number>()
    for (const job of this.runningJobs()) {
      if (job.leaseId === lease.leaseId && job.process.pid) tracked.add(job.process.pid)
    }
    for (const active of this.activeMutationProcesses.values()) {
      if (active.leaseId === lease.leaseId && active.child.pid) tracked.add(active.child.pid)
    }
    for (const pid of this.processInspector(lease.uid)) tracked.add(pid)
    if (lease.activeJobIds.length > 0 || tracked.size > 0) {
      throw new Error(
        `read-only Git inspection requires a quiescent workspace; active lease processes: ${[...tracked].sort((a, b) => a - b).join(',') || 'tracked'}`,
      )
    }
  }

  async withReadOnlyGitInspection<A>(
    sessionId: string,
    auth: AuthContext,
    requestedCwd: string | undefined,
    action: (context: ReadOnlyGitInspectionContext) => Promise<A>,
  ) {
    const inspection = this.leases.inspectionContext(sessionId, auth, requestedCwd)
    const lease = inspection.lease
    if (lease) {
      if (this.gitInspectionLeases.has(lease.leaseId)) {
        throw new Error('read-only Git inspection is already active for this workspace')
      }
      this.gitInspectionLeases.add(lease.leaseId)
    }
    let scratch: ReturnType<WorkspaceLeaseManager['prepareReadOnlyGitIndexScratch']> | null = null
    try {
      if (lease) this.assertLeaseGitInspectionQuiescent(lease)
      const uid = lease?.uid ?? this.config.inspectionUid
      const gid = lease?.gid ?? this.config.inspectionGid
      scratch = this.leases.prepareReadOnlyGitIndexScratch(inspection.repositoryRoot, uid, gid)
      return await action({
        cwd: inspection.cwd,
        configOverrides: this.leases.readOnlyGitConfigOverrides(inspection.repositoryRoot),
        gitConfigPath: scratch.configPath,
        gitHooksPath: scratch.hooksPath,
        gitIndexPath: scratch.indexPath,
        scratchRoot: scratch.writableRoot,
      })
    } finally {
      try {
        scratch?.cleanup()
      } finally {
        if (lease) this.gitInspectionLeases.delete(lease.leaseId)
      }
    }
  }

  private assertConfinementAvailable() {
    const bash = trustedExecutablePath(this.config.trustedExecutables, 'bash')
    const landlock = trustedExecutablePath(this.config.trustedExecutables, 'landlock')
    const env = { PATH: trustedPathValue(this.config.trustedExecutables), TERM: 'dumb' }
    const check = spawnSync(landlock, ['--check'], { env, encoding: 'utf8' })
    if (check.error) throw check.error
    if (check.status !== 0) {
      throw new Error(`Landlock confinement unavailable: ${(check.stderr || check.stdout).trim()}`)
    }
    const smokeCwdFd = openPinnedCwd('/', '/')
    let smoke
    try {
      smoke = spawnSync(
        landlock,
        [
          '--uid',
          String(this.config.inspectionUid),
          '--gid',
          String(this.config.inspectionGid),
          '--parent-pid',
          String(process.pid),
          '--cwd-fd',
          String(CHILD_CWD_FD),
          '--read-only',
          '--',
          bash,
          '--noprofile',
          '--norc',
          '-c',
          'true',
        ],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', smokeCwdFd] },
      )
    } finally {
      closeSync(smokeCwdFd)
    }
    if (smoke.error) throw smoke.error
    if (smoke.status !== 0) {
      throw new Error(`Landlock UID confinement smoke failed: ${(smoke.stderr || smoke.stdout).trim()}`)
    }
    return { landlock: check.stdout.trim() }
  }

  parseCommandInput(
    args: { command: string; cwd?: string; timeoutSeconds?: number; maxOutputBytes?: number },
    auth: AuthContext,
    sessionId: string,
  ): CommandInput {
    const { lease, cwd } = this.leases.requireActive(sessionId, auth, args.cwd)
    return {
      command: args.command,
      cwd,
      timeoutSeconds: asPositiveInteger(
        args.timeoutSeconds,
        'timeoutSeconds',
        this.config.defaultTimeoutSeconds,
        this.config.maxTimeoutSeconds,
      ),
      maxOutputBytes: asPositiveInteger(
        args.maxOutputBytes,
        'maxOutputBytes',
        this.config.defaultOutputBytes,
        this.config.maxOutputBytes,
        1024,
      ),
      sessionId,
      leaseId: lease.leaseId,
      leaseExpiresAt: lease.expiresAt,
    }
  }

  audit(event: string, auth: AuthContext | null, payload: Record<string, unknown>, required = false) {
    writeAuditLog(this.config, event, auth, payload, { required })
  }

  runningJobs(sessionId?: string) {
    return Array.from(this.jobs.values()).filter(
      (job) => job.status === 'running' && (sessionId == null || job.sessionId === sessionId),
    )
  }

  start(input: CommandInput, auth: AuthContext): ShellJob {
    if (this.runningJobs().length >= this.config.maxConcurrentJobs) {
      throw new Error(`max concurrent jobs reached: ${this.config.maxConcurrentJobs}`)
    }

    const active = this.leases.requireActive(input.sessionId, auth, input.cwd)
    if (active.lease.leaseId !== input.leaseId) throw new Error('workspace lease changed before job start')
    this.assertMutationAllowed(active.lease)
    const bash = trustedExecutablePath(this.config.trustedExecutables, 'bash')
    const landlock = trustedExecutablePath(this.config.trustedExecutables, 'landlock')
    const bashArgs = ['--noprofile', '--norc', '-c', input.command]
    const jobId = randomUUID()
    const cwdFd = openPinnedCwd(active.lease.workspacePath, active.cwd)
    try {
      this.leases.bindJob(active.lease, jobId, auth)
    } catch (error) {
      closeSync(cwdFd)
      throw error
    }

    let child
    try {
      child = spawn(
        landlock,
        this.leases.confinementArgs(active.lease, bash, bashArgs, true, undefined, CHILD_CWD_FD),
        {
          env: this.leases.environment(active.lease),
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe', cwdFd],
        },
      )
    } catch (error) {
      try {
        this.leases.unbindJob(active.lease.leaseId, jobId, auth)
      } catch {
        this.revokeAfterAuditFailure(active.lease.leaseId, auth)
      }
      throw error
    } finally {
      closeSync(cwdFd)
    }
    const job: ShellJob = {
      id: jobId,
      sessionId: input.sessionId,
      leaseId: input.leaseId,
      command: input.command,
      cwd: active.cwd,
      process: child,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      exitCode: null,
      signal: null,
      timedOut: false,
      timeout: null,
      stdout: tail(),
      stderr: tail(),
    }

    child.stdout!.on('data', (chunk: Buffer) => appendTail(job.stdout, Buffer.from(chunk), input.maxOutputBytes))
    child.stderr!.on('data', (chunk: Buffer) => appendTail(job.stderr, Buffer.from(chunk), input.maxOutputBytes))
    child.on('close', (code, signal) => {
      if (job.timeout) clearTimeout(job.timeout)
      job.timeout = null
      if (job.status === 'running') job.status = 'exited'
      job.exitCode = code
      job.signal = signal ?? job.signal
      job.finishedAt = new Date().toISOString()
      try {
        this.leases.unbindJob(job.leaseId, job.id, auth)
        this.audit(
          'shell_job_finished',
          auth,
          {
            jobId: job.id,
            leaseId: job.leaseId,
            sessionHash: active.lease.sessionHash,
            status: job.status,
            exitCode: code,
            signal: job.signal,
            timedOut: job.timedOut,
          },
          true,
        )
      } catch (error) {
        this.revokeAfterAuditFailure(job.leaseId, auth)
        console.error('[agents-shell] failed to persist job completion audit', error)
      }
    })
    child.on('error', (error) => appendTail(job.stderr, Buffer.from(String(error)), input.maxOutputBytes))
    job.timeout = setTimeout(() => {
      if (job.status !== 'running') return
      job.timedOut = true
      job.status = 'timed_out'
      job.signal = 'SIGTERM'
      this.killProcessGroup(job, 'SIGTERM')
    }, input.timeoutSeconds * 1000)

    this.jobs.set(job.id, job)
    try {
      this.audit(
        'shell_job_started',
        auth,
        {
          jobId: job.id,
          leaseId: job.leaseId,
          sessionHash: active.lease.sessionHash,
          command: input.command,
          cwd: active.cwd,
          timeoutSeconds: input.timeoutSeconds,
        },
        true,
      )
    } catch (error) {
      job.status = 'killed'
      job.signal = 'SIGKILL'
      this.killProcessGroup(job, 'SIGKILL')
      this.jobs.delete(job.id)
      try {
        this.leases.unbindJob(job.leaseId, job.id, auth)
      } catch {
        // The lease is revoked below because its audit sink is no longer reliable.
      }
      this.revokeAfterAuditFailure(job.leaseId, auth)
      throw error
    }
    return job
  }

  async run(input: CommandInput, auth: AuthContext) {
    const job = this.start(input, auth)
    await new Promise<void>((resolvePromise) => job.process.once('close', () => resolvePromise()))
    return job
  }

  killProcessGroup(job: ShellJob, signal: NodeJS.Signals = 'SIGTERM') {
    return killDetachedProcess(job.process, signal)
  }

  kill(jobId: string, sessionId: string, auth: AuthContext, signal: NodeJS.Signals = 'SIGTERM') {
    const job = this.requireOwnedJob(jobId, sessionId)
    if (job.status !== 'running') return job
    const killed = this.killProcessGroup(job, signal)
    if (killed) {
      job.status = 'killed'
      job.signal = signal
      try {
        this.audit('shell_job_killed', auth, { jobId: job.id, leaseId: job.leaseId, signal }, true)
      } catch (error) {
        this.revokeAfterAuditFailure(job.leaseId, auth)
        throw error
      }
    }
    return job
  }

  requireJob(jobId: string) {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`unknown jobId: ${jobId}`)
    return job
  }

  requireOwnedJob(jobId: string, sessionId: string) {
    const job = this.requireJob(jobId)
    if (job.sessionId !== sessionId) throw new Error(`job is owned by another MCP session: ${jobId}`)
    return job
  }

  jobsForSession(sessionId: string) {
    return Array.from(this.jobs.values()).filter((job) => job.sessionId === sessionId)
  }

  revokeSession(sessionId: string, auth: AuthContext | null, reason: string) {
    return this.leases.revokeSession(sessionId, auth, reason)
  }

  runProcessEffect(options: ProcessOptions): Effect.Effect<ProcessResult, unknown> {
    return Effect.tryPromise({
      try: async () => {
        const timeoutSeconds = asPositiveInteger(
          options.timeoutSeconds,
          'timeoutSeconds',
          this.config.defaultTimeoutSeconds,
          this.config.maxTimeoutSeconds,
        )
        const maxOutputBytes = asPositiveInteger(
          options.maxOutputBytes,
          'maxOutputBytes',
          this.config.defaultOutputBytes,
          this.config.maxOutputBytes,
          1024,
        )
        const executable = trustedExecutablePath(this.config.trustedExecutables, options.command)
        const landlock = trustedExecutablePath(this.config.trustedExecutables, 'landlock')
        const commandLine = formatCommand(options.command, options.args)
        const stdout = tail()
        const stderr = tail()
        let timedOut = false
        let lease: WorkspaceLease | null = null
        let mutationId: string | null = null
        let cwd: string
        let cwdRoot: string
        let env: NodeJS.ProcessEnv

        if (options.mutation) {
          const active = this.leases.requireActive(options.sessionId, options.auth, options.cwd)
          lease = active.lease
          this.assertMutationAllowed(lease)
          cwd = active.cwd
          cwdRoot = active.lease.workspacePath
          env = this.leases.environment(lease)
          mutationId = randomUUID()
          this.leases.bindJob(lease, mutationId, options.auth)
        } else {
          const inspection = this.leases.inspectionContext(options.sessionId, options.auth, options.cwd)
          cwd = inspection.cwd
          cwdRoot = inspection.repositoryRoot
          lease = inspection.lease
          env = this.leases.inspectionEnvironment(lease, cwd)
        }
        if (options.readOnlyGitIndexPath || options.readOnlyGitConfigPath) {
          if (!options.readOnlyGitIndexPath || !options.readOnlyGitConfigPath) {
            throw new Error('read-only Git scratch requires both index and config paths')
          }
          env = {
            ...env,
            GIT_CONFIG_GLOBAL: options.readOnlyGitConfigPath,
            GIT_CONFIG_SYSTEM: options.readOnlyGitConfigPath,
            GIT_INDEX_FILE: options.readOnlyGitIndexPath,
            GIT_OPTIONAL_LOCKS: '1',
          }
        }

        try {
          this.audit(
            options.auditEvent,
            options.auth,
            {
              command: commandLine,
              cwd,
              timeoutSeconds,
              leaseId: lease?.leaseId ?? null,
              mutationId,
              sessionHash: lease?.sessionHash ?? null,
            },
            options.mutation === true,
          )
        } catch (error) {
          if (mutationId && lease) {
            try {
              this.leases.unbindJob(lease.leaseId, mutationId, options.auth)
            } catch {
              // The lease is revoked below because its audit sink is no longer reliable.
            }
            this.revokeAfterAuditFailure(lease.leaseId, options.auth)
          }
          throw error
        }

        let child: ChildProcess
        let cwdFd: number | null = null
        try {
          cwdFd = openPinnedCwd(cwdRoot, cwd)
          child = spawn(
            landlock,
            this.leases.confinementArgs(
              lease,
              executable,
              options.args,
              options.mutation === true,
              options.readOnlyScratchRoot,
              CHILD_CWD_FD,
            ),
            {
              env,
              detached: true,
              stdio: ['pipe', 'pipe', 'pipe', cwdFd],
            },
          )
        } catch (error) {
          if (mutationId && lease) {
            try {
              this.leases.unbindJob(lease.leaseId, mutationId, options.auth)
            } catch {
              this.revokeAfterAuditFailure(lease.leaseId, options.auth)
            }
          }
          throw error
        } finally {
          if (cwdFd != null) closeSync(cwdFd)
        }
        if (mutationId && lease) {
          this.activeMutationProcesses.set(mutationId, {
            id: mutationId,
            sessionId: options.sessionId,
            leaseId: lease.leaseId,
            child,
          })
        }

        child.stdout!.on('data', (chunk: Buffer) => appendTail(stdout, Buffer.from(chunk), maxOutputBytes))
        child.stderr!.on('data', (chunk: Buffer) => appendTail(stderr, Buffer.from(chunk), maxOutputBytes))
        if (options.stdin != null) child.stdin!.write(options.stdin)
        child.stdin!.end()

        let cleanupError: unknown = null
        let timeoutTerminationError: unknown = null
        let timeout: ReturnType<typeof setTimeout> | null = null
        const result = await new Promise<{ exitCode: number | null; signal: string | null }>(
          (resolvePromise, reject) => {
            let settled = false
            const settle = (value: { exitCode: number | null; signal: string | null }) => {
              if (settled) return
              settled = true
              resolvePromise(value)
            }
            child.once('error', (error) => {
              if (settled) return
              settled = true
              reject(error)
            })
            child.once('close', (exitCode, signal) => settle({ exitCode, signal }))
            timeout = setTimeout(() => {
              timedOut = true
              killDetachedProcess(child, 'SIGTERM')
              if (options.mutation && lease) {
                try {
                  this.terminateLeaseProcesses(lease)
                } catch (error) {
                  timeoutTerminationError = error
                }
              }
              child.stdin?.destroy()
              child.stdout?.destroy()
              child.stderr?.destroy()
              settle({ exitCode: child.exitCode, signal: child.signalCode })
            }, timeoutSeconds * 1000)
          },
        ).finally(() => {
          if (timeout) clearTimeout(timeout)
          if (mutationId) this.activeMutationProcesses.delete(mutationId)
          if (mutationId && lease) {
            try {
              this.leases.unbindJob(lease.leaseId, mutationId, options.auth)
            } catch (error) {
              cleanupError = error
              this.revokeAfterAuditFailure(lease.leaseId, options.auth)
            }
          }
        })
        if (timeoutTerminationError) throw timeoutTerminationError
        if (cleanupError) throw cleanupError

        const processResult = toProcessResult(
          commandLine,
          cwd,
          result.exitCode,
          result.signal,
          timedOut,
          stdout,
          stderr,
          maxOutputBytes,
          new Set(options.okExitCodes ?? [0]),
        )
        try {
          this.audit(
            `${options.auditEvent}_finished`,
            options.auth,
            {
              command: commandLine,
              cwd,
              leaseId: lease?.leaseId ?? null,
              mutationId,
              exitCode: result.exitCode,
              signal: result.signal,
              timedOut,
            },
            options.mutation === true,
          )
        } catch (error) {
          if (lease) this.revokeAfterAuditFailure(lease.leaseId, options.auth)
          throw error
        }
        return processResult
      },
      catch: (error) => error,
    })
  }

  async runProcess(options: ProcessOptions): Promise<ProcessResult> {
    return Effect.runPromise(this.runProcessEffect(options))
  }

  async acquireWorkspace(sessionId: string, auth: AuthContext, input: WorkspaceAcquireInput) {
    return await this.leases.acquire(sessionId, auth, input)
  }

  workspaceStatus(sessionId: string, auth: AuthContext) {
    return this.leases.status(sessionId, auth)
  }

  async releaseWorkspace(sessionId: string, auth: AuthContext) {
    return await this.leases.release(sessionId, auth)
  }

  shutdown() {
    for (const job of this.runningJobs()) {
      job.status = 'killed'
      job.signal = 'SIGKILL'
      this.killProcessGroup(job, 'SIGKILL')
    }
    for (const active of this.activeMutationProcesses.values()) {
      killDetachedProcess(active.child, 'SIGKILL')
    }
    this.activeMutationProcesses.clear()
    this.leases.shutdown()
  }
}
