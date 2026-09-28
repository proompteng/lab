import { readFile, watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FSWatcher } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type * as ParseResult from '@effect/schema/ParseResult'
import * as Schema from '@effect/schema/Schema'
import * as TreeFormatter from '@effect/schema/TreeFormatter'
import { Context, Effect, Layer, Runtime } from 'effect'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import * as Stream from 'effect/Stream'
import YAML from 'yaml'

import { toSymphonyConfigEffect } from './config'
import { ConfigError, WorkflowError, toLogError } from './errors'
import type { LoadedWorkflow, SymphonyConfig, WorkflowDefinition } from './types'
import type { Logger } from './logger'

const WorkflowFrontMatterSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
})

const decodeWorkflowFrontMatter = Schema.decodeUnknown(WorkflowFrontMatterSchema)

const formatSchemaError = (error: ParseResult.ParseError): string => TreeFormatter.formatErrorSync(error)

const readFileText = (filePath: string): Effect.Effect<string, WorkflowError, never> =>
  Effect.async((resume) => {
    readFile(filePath, 'utf8', (error, data) => {
      if (error) {
        resume(
          Effect.fail(new WorkflowError('missing_workflow_file', `failed to read workflow file ${filePath}`, error)),
        )
        return
      }
      resume(Effect.succeed(data))
    })
  })

const parseFrontMatter = (
  workflowPath: string,
  content: string,
): Effect.Effect<WorkflowDefinition, WorkflowError, never> => {
  if (!content.startsWith('---')) {
    return Effect.succeed({
      config: {},
      promptTemplate: content.trim(),
    })
  }

  const lines = content.split(/\r?\n/)
  let closingIndex = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      closingIndex = index
      break
    }
  }

  if (closingIndex === -1) {
    return Effect.fail(
      new WorkflowError('workflow_parse_error', `workflow ${workflowPath} front matter is missing closing delimiter`),
    )
  }

  const yamlText = lines.slice(1, closingIndex).join('\n')
  const promptTemplate = lines
    .slice(closingIndex + 1)
    .join('\n')
    .trim()

  return Effect.try({
    try: () => (yamlText.trim().length > 0 ? YAML.parse(yamlText) : {}),
    catch: (error) => new WorkflowError('workflow_parse_error', 'failed to parse workflow front matter', error),
  }).pipe(
    Effect.flatMap((parsed) =>
      decodeWorkflowFrontMatter(parsed).pipe(
        Effect.mapError(
          (error) => new WorkflowError('workflow_front_matter_not_a_map', formatSchemaError(error), error),
        ),
      ),
    ),
    Effect.map((config) => ({
      config,
      promptTemplate,
    })),
  )
}

const readLoadedWorkflowEffect = (
  workflowPath: string,
): Effect.Effect<LoadedWorkflow, WorkflowError | ConfigError, never> =>
  Effect.gen(function* () {
    const resolvedPath = resolve(workflowPath)
    const content = yield* readFileText(resolvedPath)
    const definition = yield* parseFrontMatter(resolvedPath, content)
    const metadata = yield* Effect.tryPromise({
      try: () => stat(resolvedPath),
      catch: (error) =>
        new WorkflowError('missing_workflow_file', `failed to stat workflow file ${resolvedPath}`, error),
    })
    const config = yield* toSymphonyConfigEffect(resolvedPath, definition.config)

    return {
      definition,
      config,
      mtimeMs: metadata.mtimeMs,
    } satisfies LoadedWorkflow
  })

export const loadWorkflowFileEffect = (workflowPath: string): Effect.Effect<WorkflowDefinition, WorkflowError, never> =>
  readFileText(resolve(workflowPath)).pipe(
    Effect.flatMap((content) => parseFrontMatter(resolve(workflowPath), content)),
  )

export const loadWorkflowFile = (workflowPath: string): Promise<WorkflowDefinition> =>
  Effect.runPromise(loadWorkflowFileEffect(workflowPath))

export interface WorkflowServiceDefinition {
  readonly current: Effect.Effect<
    { definition: WorkflowDefinition; config: SymphonyConfig },
    WorkflowError | ConfigError
  >
  readonly config: Effect.Effect<SymphonyConfig, WorkflowError | ConfigError>
  readonly reload: Effect.Effect<
    { definition: WorkflowDefinition; config: SymphonyConfig },
    WorkflowError | ConfigError
  >
  readonly changes: Stream.Stream<{ definition: WorkflowDefinition; config: SymphonyConfig }>
}

export class WorkflowService extends Context.Tag('symphony/WorkflowService')<
  WorkflowService,
  WorkflowServiceDefinition
>() {}

export const makeWorkflowLayer = (workflowPath: string, logger: Logger) =>
  Layer.scoped(
    WorkflowService,
    Effect.gen(function* () {
      const resolvedPath = resolve(workflowPath)
      const runtime = yield* Effect.runtime<never>()
      const workflowLogger = logger.child({ component: 'workflow-service', workflow_path: resolvedPath })
      const initial = yield* readLoadedWorkflowEffect(resolvedPath)
      const ref = yield* SubscriptionRef.make(initial)

      const reloadAndKeepLastKnownGood = readLoadedWorkflowEffect(resolvedPath).pipe(
        Effect.flatMap((loaded) =>
          SubscriptionRef.set(ref, loaded).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                workflowLogger.log('info', 'workflow_reloaded', {
                  poll_interval_ms: loaded.config.pollingIntervalMs,
                  max_concurrent_agents: loaded.config.agent.maxConcurrentAgents,
                })
              }),
            ),
            Effect.as(loaded),
          ),
        ),
      )

      const safeReload = reloadAndKeepLastKnownGood.pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            workflowLogger.log('error', 'workflow_reload_failed', toLogError(error))
          }).pipe(Effect.zipRight(SubscriptionRef.get(ref))),
        ),
      )

      yield* Effect.acquireRelease(
        Effect.sync(() =>
          watch(dirname(resolvedPath), { persistent: false }, (_eventType, filename) => {
            if (filename && resolve(dirname(resolvedPath), filename.toString()) !== resolvedPath) return
            Runtime.runFork(runtime)(safeReload)
          }),
        ),
        (resource: FSWatcher) =>
          Effect.sync(() => {
            resource.close()
          }),
      )

      const current = Effect.gen(function* () {
        const latest = yield* SubscriptionRef.get(ref)
        const metadata = yield* Effect.tryPromise({
          try: () => stat(resolvedPath),
          catch: (error) =>
            new WorkflowError('missing_workflow_file', `failed to stat workflow file ${resolvedPath}`, error),
        }).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              workflowLogger.log('warn', 'workflow_stat_failed', toLogError(error))
            }).pipe(Effect.zipRight(Effect.succeed<{ mtimeMs: number }>({ mtimeMs: latest.mtimeMs }))),
          ),
        )

        if (metadata.mtimeMs > latest.mtimeMs) {
          return yield* safeReload.pipe(
            Effect.map((loaded) => ({ definition: loaded.definition, config: loaded.config })),
          )
        }

        return {
          definition: latest.definition,
          config: latest.config,
        }
      })

      return {
        current,
        config: current.pipe(Effect.map((loaded) => loaded.config)),
        reload: safeReload.pipe(Effect.map((loaded) => ({ definition: loaded.definition, config: loaded.config }))),
        changes: ref.changes.pipe(
          Stream.map((loaded) => ({
            definition: loaded.definition,
            config: loaded.config,
          })),
        ),
      } satisfies WorkflowServiceDefinition
    }),
  )
