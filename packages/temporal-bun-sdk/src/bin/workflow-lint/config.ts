import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export type WorkflowLintMode = 'strict' | 'warn' | 'off'
export type WorkflowLintFormat = 'text' | 'json'

export type WorkflowLintConfig = {
  readonly entries: readonly string[]
  readonly allow?: {
    readonly imports?: readonly string[]
    readonly globals?: readonly string[]
    readonly memberExpressions?: readonly string[]
  }
  readonly deny?: {
    readonly imports?: readonly string[]
    readonly globals?: readonly string[]
    readonly memberExpressions?: readonly string[]
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object')

const readStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item) => typeof item === 'string').map((item) => item.trim())
  return items.filter((item) => item.length > 0)
}

export const loadWorkflowLintConfig = async (
  cwdPath: string,
  configPath?: string,
): Promise<{ config?: WorkflowLintConfig; source?: string }> => {
  const resolved = configPath ? resolve(cwdPath, configPath) : resolve(cwdPath, '.temporal-bun-workflows.json')
  try {
    const raw = await readFile(resolved, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) {
      throw new Error('workflow lint config must be a JSON object')
    }
    const entries = readStringArray(parsed.entries) ?? []
    if (entries.length === 0) {
      throw new Error('workflow lint config requires a non-empty "entries" array')
    }

    const allowRaw = isRecord(parsed.allow) ? parsed.allow : undefined
    const denyRaw = isRecord(parsed.deny) ? parsed.deny : undefined
    const config: WorkflowLintConfig = {
      entries,
      allow: allowRaw
        ? {
            imports: readStringArray(allowRaw.imports),
            globals: readStringArray(allowRaw.globals),
            memberExpressions: readStringArray(allowRaw.memberExpressions),
          }
        : undefined,
      deny: denyRaw
        ? {
            imports: readStringArray(denyRaw.imports),
            globals: readStringArray(denyRaw.globals),
            memberExpressions: readStringArray(denyRaw.memberExpressions),
          }
        : undefined,
    }

    return { config, source: resolved }
  } catch (error) {
    if (!configPath) {
      return { config: undefined, source: undefined }
    }
    throw error
  }
}
