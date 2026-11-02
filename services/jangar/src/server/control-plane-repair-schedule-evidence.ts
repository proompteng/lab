import { parseNamespaceScopeEnv } from '~/server/namespace-scope'

const DEFAULT_REPAIR_SCHEDULE_EVIDENCE_NAMESPACES = ['agents']
const REPAIR_SCHEDULE_EVIDENCE_NAMESPACES_ENV = 'JANGAR_REPAIR_SCHEDULE_EVIDENCE_NAMESPACES'

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

const uniqueStrings = (values: string[]) => {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    output.push(value)
  }
  return output
}

export const resolveRepairScheduleEvidenceNamespaces = (
  namespace: string,
  env: Record<string, string | undefined> = process.env,
) => {
  const fallback = uniqueStrings([namespace, ...DEFAULT_REPAIR_SCHEDULE_EVIDENCE_NAMESPACES])

  try {
    return uniqueStrings(
      parseNamespaceScopeEnv(
        REPAIR_SCHEDULE_EVIDENCE_NAMESPACES_ENV,
        {
          fallback,
          label: 'repair schedule evidence',
        },
        env,
      ),
    )
  } catch (error) {
    console.warn(`[jangar] failed to parse ${REPAIR_SCHEDULE_EVIDENCE_NAMESPACES_ENV}: ${normalizeMessage(error)}`)
    return fallback
  }
}
