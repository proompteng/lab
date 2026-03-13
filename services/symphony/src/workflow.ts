import { readFile, watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import YAML from 'yaml'

import { SymphonyError } from './errors'
import type { Logger } from './logger'
import { toSymphonyConfig } from './config'
import type { SymphonyConfig, WorkflowDefinition } from './types'

const readFileText = async (filePath: string): Promise<string> =>
  new Promise((resolvePromise, rejectPromise) => {
    readFile(filePath, 'utf8', (error, data) => {
      if (error) {
        rejectPromise(error)
        return
      }
      resolvePromise(data)
    })
  })

const readFrontMatter = (content: string): WorkflowDefinition => {
  if (!content.startsWith('---')) {
    return {
      config: {},
      promptTemplate: content.trim(),
    }
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
    throw new SymphonyError('workflow_parse_error', 'workflow front matter is missing closing delimiter')
  }

  const yamlText = lines.slice(1, closingIndex).join('\n')
  const body = lines
    .slice(closingIndex + 1)
    .join('\n')
    .trim()

  let parsed: unknown
  try {
    parsed = yamlText.trim().length > 0 ? YAML.parse(yamlText) : {}
  } catch (error) {
    throw new SymphonyError('workflow_parse_error', 'failed to parse workflow front matter', error)
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new SymphonyError('workflow_front_matter_not_a_map', 'workflow front matter must decode to a map')
  }

  return {
    config: parsed as Record<string, unknown>,
    promptTemplate: body,
  }
}

export const loadWorkflowFile = async (workflowPath: string): Promise<WorkflowDefinition> => {
  try {
    const content = await readFileText(workflowPath)
    return readFrontMatter(content)
  } catch (error) {
    if (error instanceof SymphonyError) throw error
    throw new SymphonyError('missing_workflow_file', `failed to read workflow file ${workflowPath}`, error)
  }
}

export class WorkflowStore {
  private readonly workflowPath: string
  private readonly logger: Logger
  private watcher: FSWatcher | null = null
  private lastKnownGood: { definition: WorkflowDefinition; config: SymphonyConfig } | null = null
  private lastLoadedMtimeMs = 0

  constructor(workflowPath: string, logger: Logger) {
    this.workflowPath = resolve(workflowPath)
    this.logger = logger.child({ component: 'workflow-store', workflow_path: this.workflowPath })
  }

  async initialize(): Promise<void> {
    const loaded = await this.reload()
    this.lastKnownGood = loaded
  }

  async getCurrent(): Promise<{ definition: WorkflowDefinition; config: SymphonyConfig }> {
    await this.reloadIfChanged()
    if (!this.lastKnownGood) {
      await this.initialize()
    }
    if (!this.lastKnownGood) {
      throw new SymphonyError('missing_workflow_file', `workflow file ${this.workflowPath} is unavailable`)
    }
    return this.lastKnownGood
  }

  startWatching(): void {
    if (this.watcher) return
    const directory = dirname(this.workflowPath)
    this.watcher = watch(directory, { persistent: false }, async (_eventType, filename) => {
      if (filename && resolve(directory, filename.toString()) !== this.workflowPath) return
      try {
        await this.reload()
      } catch (error) {
        this.logger.log('error', 'workflow_reload_failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
  }

  private async reloadIfChanged(): Promise<void> {
    let nextMtimeMs: number
    try {
      const metadata = await stat(this.workflowPath)
      nextMtimeMs = metadata.mtimeMs
    } catch (error) {
      if (!this.lastKnownGood) {
        throw new SymphonyError('missing_workflow_file', `failed to stat workflow file ${this.workflowPath}`, error)
      }
      this.logger.log('warn', 'workflow_stat_failed', { error: error instanceof Error ? error.message : String(error) })
      return
    }

    if (nextMtimeMs <= this.lastLoadedMtimeMs && this.lastKnownGood) return
    try {
      await this.reload()
    } catch (error) {
      if (!this.lastKnownGood) throw error
      this.logger.log('error', 'workflow_reload_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async reload(): Promise<{ definition: WorkflowDefinition; config: SymphonyConfig }> {
    const definition = await loadWorkflowFile(this.workflowPath)
    const config = toSymphonyConfig(this.workflowPath, definition.config)
    const metadata = await stat(this.workflowPath)

    const loaded = { definition, config }
    this.lastKnownGood = loaded
    this.lastLoadedMtimeMs = metadata.mtimeMs
    this.logger.log('info', 'workflow_reloaded', {
      poll_interval_ms: config.pollingIntervalMs,
      max_concurrent_agents: config.agent.maxConcurrentAgents,
    })
    return loaded
  }
}
