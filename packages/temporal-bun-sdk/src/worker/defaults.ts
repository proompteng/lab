import { readFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import * as defaultActivities from '../activities'
import type { ActivityHandler } from './runtime'

const PACKAGE_NAME = '@proompteng/temporal-bun-sdk'

export const DEFAULT_WORKFLOWS_PATH = fileURLToPath(new URL('../workflows/index.js', import.meta.url))

let cachedBuildId: string | null = null

export const deriveWorkerBuildId = (): string => {
  if (cachedBuildId) {
    return cachedBuildId
  }

  const envOverride = process.env.TEMPORAL_WORKER_BUILD_ID?.trim()
  if (envOverride) {
    cachedBuildId = envOverride
    return envOverride
  }

  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))
    const payload = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    const version = typeof payload.version === 'string' ? payload.version.trim() : ''
    if (name === PACKAGE_NAME && version.length > 0) {
      const candidate = `${name}@${version}`
      cachedBuildId = candidate
      return candidate
    }
  } catch {
    // fall through and return hostname-based identifier
  }

  const fallback = `${os.hostname()}-${process.pid}@dev`
  cachedBuildId = fallback
  return fallback
}

const BUILTIN_ACTIVITIES = defaultActivities as unknown as Record<string, ActivityHandler>

export const resolveWorkerActivities = (activities?: CreateWorkerActivities): Record<string, ActivityHandler> =>
  activities ?? BUILTIN_ACTIVITIES

export const resolveWorkerWorkflowsPath = (input?: CreateWorkerWorkflowsPath): string | undefined => {
  if (input === undefined || input === null) {
    return DEFAULT_WORKFLOWS_PATH
  }
  if (typeof input === 'string') {
    return input
  }
  const candidate = input as unknown
  if (Array.isArray(candidate) && candidate.length > 0) {
    const [first] = candidate
    if (typeof first === 'string') {
      return first
    }
  }
  throw new Error('workflowsPath must be a string when using the Temporal worker runtime')
}

type CreateWorkerActivities = Record<string, ActivityHandler> | undefined
type CreateWorkerWorkflowsPath = string | string[] | undefined
