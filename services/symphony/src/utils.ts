import { tmpdir } from 'node:os'
import path from 'node:path'

export const DEFAULT_WORKSPACE_ROOT = path.join(tmpdir(), 'symphony_workspaces')

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const normalizeState = (state: string | null | undefined): string =>
  String(state ?? '')
    .trim()
    .toLowerCase()

export const sanitizeWorkspaceKey = (identifier: string): string => identifier.replace(/[^A-Za-z0-9._-]/g, '_')

export const toAbsolutePath = (value: string): string =>
  path.isAbsolute(value) ? path.normalize(value) : path.resolve(value)

export const ensurePathInsideRoot = (workspaceRoot: string, candidate: string): boolean => {
  const root = toAbsolutePath(workspaceRoot)
  const target = toAbsolutePath(candidate)
  if (root === target) return true
  const relative = path.relative(root, target)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export const readNumber = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

export const readPositiveNumber = (value: unknown, fallback: number): number => {
  const parsed = readNumber(value, fallback)
  return parsed > 0 ? parsed : fallback
}

export const normalizeStringList = (value: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(value)) return fallback
  const values = value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
  return values.length > 0 ? values : fallback
}

export const parseIsoTimestamp = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

export const expandPathValue = (rawValue: string, env: NodeJS.ProcessEnv): string => {
  const envExpanded = rawValue.startsWith('$') ? (env[rawValue.slice(1)] ?? '') : rawValue
  if (envExpanded.startsWith('~')) {
    const home = env.HOME ?? process.env.HOME ?? ''
    return path.join(home, envExpanded.slice(1))
  }
  return envExpanded
}

export const hasPathSeparator = (value: string): boolean =>
  value.includes(path.sep) || value.includes('/') || value.includes('\\')
