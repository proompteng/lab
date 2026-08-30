import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as defaultActivities from '../activities'
import type { ActivityHandler } from './runtime'

const PACKAGE_NAME = '@proompteng/temporal-bun-sdk'

export const DEFAULT_WORKFLOWS_PATH = fileURLToPath(new URL('../workflows/index.js', import.meta.url))

let cachedBuildId: string | null = null

const workflowBuildIdExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'])

const listFilesRecursively = (root: string): string[] => {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(current)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      let entries: string[]
      try {
        entries = readdirSync(current)
      } catch {
        continue
      }
      for (const entry of entries) {
        stack.push(path.join(current, entry))
      }
      continue
    }
    if (!stats.isFile()) {
      continue
    }
    const ext = path.extname(current)
    if (workflowBuildIdExtensions.has(ext)) {
      out.push(current)
    }
  }
  out.sort((a, b) => a.localeCompare(b))
  return out
}

export const deriveWorkerBuildIdFromWorkflowsPath = (workflowsPath: string | undefined): string | undefined => {
  if (!workflowsPath) {
    return undefined
  }

  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(workflowsPath)
  } catch {
    return undefined
  }

  const root = stats.isDirectory() ? workflowsPath : path.dirname(workflowsPath)
  const files = listFilesRecursively(root)
  if (files.length === 0) {
    return undefined
  }

  const hasher = createHash('sha256')
  for (const file of files) {
    const relative = path.relative(root, file)
    hasher.update(relative)
    hasher.update('\0')
    try {
      hasher.update(readFileSync(file))
    } catch {
      // If a file disappears mid-walk, fall back to whatever we hashed so far.
    }
    hasher.update('\0')
  }

  const digest = hasher.digest('hex').slice(0, 16)
  return `workflow-code@${digest}`
}

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
