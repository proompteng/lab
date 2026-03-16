import { spawn } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { Context, Effect, Layer } from 'effect'
import * as Duration from 'effect/Duration'

import { ConfigError, WorkspaceError, WorkflowError, toLogError } from './errors'
import type { WorkspaceHookContext, WorkspaceInfo } from './types'
import { ensurePathInsideRoot, sanitizeWorkspaceKey, toAbsolutePath } from './utils'
import { WorkflowService } from './workflow'
import type { Logger } from './logger'

const PREP_GARBAGE = ['tmp', '.elixir_ls', '.bun-tmp']
const MAX_HOOK_LOG_BYTES = 4_096

const truncateOutput = (value: string): string =>
  value.length > MAX_HOOK_LOG_BYTES ? `${value.slice(0, MAX_HOOK_LOG_BYTES)}…` : value

export type ShellResult = {
  stdout: string
  stderr: string
}

export interface ShellServiceDefinition {
  readonly run: (
    script: string,
    options: {
      cwd: string
      timeoutMs: number
      hookName: 'after_create' | 'before_run' | 'after_run' | 'before_remove'
      env?: Record<string, string>
    },
  ) => Effect.Effect<ShellResult, WorkspaceError>
}

export class ShellService extends Context.Tag('symphony/ShellService')<ShellService, ShellServiceDefinition>() {}

export interface WorkspaceServiceDefinition {
  readonly createForIssue: (
    identifier: string,
  ) => Effect.Effect<WorkspaceInfo, WorkflowError | ConfigError | WorkspaceError>
  readonly runBeforeRun: (
    workspacePath: string,
    context?: WorkspaceHookContext,
  ) => Effect.Effect<void, WorkflowError | ConfigError | WorkspaceError>
  readonly runAfterRun: (
    workspacePath: string,
    context?: WorkspaceHookContext,
  ) => Effect.Effect<void, WorkflowError | ConfigError | WorkspaceError>
  readonly removeWorkspace: (identifier: string) => Effect.Effect<void, WorkflowError | ConfigError | WorkspaceError>
}

export class WorkspaceService extends Context.Tag('symphony/WorkspaceService')<
  WorkspaceService,
  WorkspaceServiceDefinition
>() {}

const cleanupEphemeralArtifacts = (workspacePath: string): Effect.Effect<void, never, never> =>
  Effect.tryPromise({
    try: async () => {
      const entries = await readdir(workspacePath)
      await Promise.all(
        entries
          .filter((entry) => PREP_GARBAGE.includes(entry))
          .map((entry) => rm(path.join(workspacePath, entry), { recursive: true, force: true })),
      )
    },
    catch: () => undefined,
  }).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
  )

export const makeShellLayer = (logger: Logger) =>
  Layer.succeed(ShellService, {
    run: (script, options) =>
      Effect.scoped(
        Effect.acquireRelease(
          Effect.sync(() =>
            spawn('bash', ['-lc', script], {
              cwd: options.cwd,
              env: {
                ...process.env,
                ...options.env,
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            }),
          ),
          (child) =>
            Effect.sync(() => {
              if (!child.killed) {
                child.kill('SIGKILL')
              }
            }),
        ).pipe(
          Effect.flatMap((child) =>
            Effect.async<ShellResult, WorkspaceError>((resume) => {
              let stdout = ''
              let stderr = ''

              child.stdout.on('data', (chunk: Buffer) => {
                stdout += chunk.toString('utf8')
              })
              child.stderr.on('data', (chunk: Buffer) => {
                stderr += chunk.toString('utf8')
              })

              child.once('error', (error) => {
                resume(
                  Effect.fail(
                    new WorkspaceError('workspace_hook_error', `hook ${options.hookName} failed to start`, error),
                  ),
                )
              })

              child.once('exit', (code, signal) => {
                if (code === 0) {
                  resume(Effect.succeed({ stdout, stderr }))
                  return
                }

                resume(
                  Effect.fail(
                    new WorkspaceError(
                      'workspace_hook_error',
                      `hook ${options.hookName} failed with code ${code ?? 'unknown'} signal ${signal ?? 'unknown'}`,
                      {
                        stdout: truncateOutput(stdout),
                        stderr: truncateOutput(stderr),
                        exitCode: code,
                        signal,
                      },
                    ),
                  ),
                )
              })

              return Effect.void
            }).pipe(
              Effect.timeoutFail({
                duration: Duration.millis(options.timeoutMs),
                onTimeout: () =>
                  new WorkspaceError(
                    'workspace_hook_timeout',
                    `hook ${options.hookName} timed out after ${options.timeoutMs}ms`,
                  ),
              }),
            ),
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              logger.log('warn', 'workspace_shell_failed', {
                hook: options.hookName,
                workspace_path: options.cwd,
                ...toLogError(error),
              })
            }),
          ),
        ),
      ),
  })

const buildHookEnv = (context?: WorkspaceHookContext): Record<string, string> => {
  const env: Record<string, string> = {}

  if (context?.issueId) env.SYMPHONY_ISSUE_ID = context.issueId
  if (context?.issueIdentifier) env.SYMPHONY_ISSUE_IDENTIFIER = context.issueIdentifier
  if (context?.issueBranchName) env.SYMPHONY_ISSUE_BRANCH_NAME = context.issueBranchName
  if (context?.issueTitle) env.SYMPHONY_ISSUE_TITLE = context.issueTitle
  if (context?.issueState) env.SYMPHONY_ISSUE_STATE = context.issueState

  return env
}

export const makeWorkspaceLayer = (logger: Logger) =>
  Layer.effect(
    WorkspaceService,
    Effect.gen(function* () {
      const workflow = yield* WorkflowService
      const shell = yield* ShellService
      const workspaceLogger = logger.child({ component: 'workspace-service' })

      const runHook = (
        hookName: 'after_create' | 'before_run' | 'after_run' | 'before_remove',
        script: string,
        workspacePath: string,
        timeoutMs: number,
        failOnError: boolean,
        context?: WorkspaceHookContext,
      ) =>
        shell.run(script, { cwd: workspacePath, timeoutMs, hookName, env: buildHookEnv(context) }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              workspaceLogger.log('info', 'workspace_hook_completed', {
                hook: hookName,
                workspace_path: workspacePath,
              })
            }),
          ),
          Effect.catchAll((error) => {
            const logLevel = failOnError ? 'error' : 'warn'
            const logEffect = Effect.sync(() => {
              workspaceLogger.log(logLevel, 'workspace_hook_failed', {
                hook: hookName,
                workspace_path: workspacePath,
                ...toLogError(error),
                ...(error.causeValue && typeof error.causeValue === 'object'
                  ? (error.causeValue as Record<string, unknown>)
                  : {}),
              })
            })

            return failOnError ? logEffect.pipe(Effect.zipRight(Effect.fail(error))) : logEffect.pipe(Effect.asVoid)
          }),
        )

      const service: WorkspaceServiceDefinition = {
        createForIssue: (identifier) =>
          Effect.gen(function* () {
            const config = yield* workflow.config
            const workspaceKey = sanitizeWorkspaceKey(identifier)
            const root = toAbsolutePath(config.workspaceRoot)
            const workspacePath = toAbsolutePath(path.join(root, workspaceKey))

            if (!ensurePathInsideRoot(root, workspacePath)) {
              return yield* Effect.fail(
                new WorkspaceError('invalid_workspace_cwd', `workspace path ${workspacePath} escapes root ${root}`),
              )
            }

            yield* Effect.tryPromise({
              try: () => mkdir(root, { recursive: true }),
              catch: (error) =>
                new WorkspaceError('workspace_create_failed', `failed to ensure workspace root ${root}`, error),
            })

            let createdNow = false

            const metadataResult = yield* Effect.either(
              Effect.tryPromise({
                try: () => stat(workspacePath),
                catch: (error) =>
                  new WorkspaceError('workspace_create_failed', `failed to inspect workspace ${workspacePath}`, error),
              }),
            )

            if (metadataResult._tag === 'Left') {
              const nodeError = metadataResult.left.causeValue as NodeJS.ErrnoException | undefined
              if (nodeError?.code && nodeError.code !== 'ENOENT') {
                return yield* Effect.fail(metadataResult.left)
              }

              yield* Effect.tryPromise({
                try: () => mkdir(workspacePath, { recursive: true }),
                catch: (error) =>
                  new WorkspaceError('workspace_create_failed', `failed to create workspace ${workspacePath}`, error),
              })
              createdNow = true
            } else if (!metadataResult.right.isDirectory()) {
              return yield* Effect.fail(
                new WorkspaceError(
                  'workspace_path_not_directory',
                  `workspace path ${workspacePath} is not a directory`,
                ),
              )
            }

            yield* cleanupEphemeralArtifacts(workspacePath)

            if (createdNow && config.hooks.afterCreate) {
              yield* runHook('after_create', config.hooks.afterCreate, workspacePath, config.hooks.timeoutMs, true, {
                issueIdentifier: identifier,
              })
            }

            return {
              path: workspacePath,
              workspaceKey,
              createdNow,
            }
          }),
        runBeforeRun: (workspacePath, context) =>
          workflow.config.pipe(
            Effect.flatMap((config) =>
              config.hooks.beforeRun
                ? runHook('before_run', config.hooks.beforeRun, workspacePath, config.hooks.timeoutMs, true, context)
                : Effect.void,
            ),
          ),
        runAfterRun: (workspacePath, context) =>
          workflow.config.pipe(
            Effect.flatMap((config) =>
              config.hooks.afterRun
                ? runHook('after_run', config.hooks.afterRun, workspacePath, config.hooks.timeoutMs, false, context)
                : Effect.void,
            ),
          ),
        removeWorkspace: (identifier) =>
          Effect.gen(function* () {
            const config = yield* workflow.config
            const workspaceKey = sanitizeWorkspaceKey(identifier)
            const root = toAbsolutePath(config.workspaceRoot)
            const workspacePath = toAbsolutePath(path.join(root, workspaceKey))

            if (!ensurePathInsideRoot(root, workspacePath)) {
              return yield* Effect.fail(
                new WorkspaceError('invalid_workspace_cwd', `workspace path ${workspacePath} escapes root ${root}`),
              )
            }

            const metadataResult = yield* Effect.either(
              Effect.tryPromise({
                try: () => stat(workspacePath),
                catch: (error) =>
                  new WorkspaceError('workspace_create_failed', `failed to inspect workspace ${workspacePath}`, error),
              }),
            )

            if (metadataResult._tag === 'Left') {
              const nodeError = metadataResult.left.causeValue as NodeJS.ErrnoException | undefined
              if (nodeError?.code === 'ENOENT') {
                return
              }
              return yield* Effect.fail(metadataResult.left)
            }

            if (!metadataResult.right.isDirectory()) {
              return yield* Effect.fail(
                new WorkspaceError(
                  'workspace_path_not_directory',
                  `workspace path ${workspacePath} is not a directory`,
                ),
              )
            }

            if (config.hooks.beforeRemove) {
              yield* runHook('before_remove', config.hooks.beforeRemove, workspacePath, config.hooks.timeoutMs, false, {
                issueIdentifier: identifier,
              })
            }

            yield* Effect.tryPromise({
              try: () => rm(workspacePath, { recursive: true, force: true }),
              catch: (error) =>
                new WorkspaceError('workspace_create_failed', `failed to remove workspace ${workspacePath}`, error),
            })

            yield* Effect.sync(() => {
              workspaceLogger.log('info', 'workspace_removed', { workspace_path: workspacePath })
            })
          }),
      }

      return service
    }),
  )
