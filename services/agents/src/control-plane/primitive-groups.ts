import { primitiveRegistry } from './registry'

export type PrimitiveRegistryEntry = (typeof primitiveRegistry)[number]

type PrimitiveGroupDefinition = {
  label: string
  pathSegments: string[]
}

export type PrimitiveGroup = {
  label: string
  entries: PrimitiveRegistryEntry[]
}

export const primitiveGroupDefinitions: PrimitiveGroupDefinition[] = [
  {
    label: 'Runtime',
    pathSegments: ['agent', 'agent-run', 'agent-provider'],
  },
  {
    label: 'Implementation',
    pathSegments: ['implementation-source', 'implementation-spec', 'version-control-provider', 'workspace'],
  },
  {
    label: 'Workflow',
    pathSegments: ['orchestration', 'orchestration-run', 'schedule', 'swarm'],
  },
  {
    label: 'I/O',
    pathSegments: ['tool', 'tool-run', 'signal', 'signal-delivery'],
  },
  {
    label: 'State',
    pathSegments: ['memory', 'artifact'],
  },
  {
    label: 'Governance',
    pathSegments: ['approval-policy', 'budget', 'secret-binding'],
  },
]

export const getPrimitiveGroups = (): PrimitiveGroup[] => {
  const byPathSegment = new Map<string, PrimitiveRegistryEntry>(
    primitiveRegistry.map((entry) => [entry.display.pathSegment, entry]),
  )
  const used = new Set<string>()
  const groups = primitiveGroupDefinitions
    .map((group) => {
      const entries = group.pathSegments.flatMap((pathSegment) => {
        const entry = byPathSegment.get(pathSegment)
        if (!entry) return []
        used.add(pathSegment)
        return [entry]
      })
      return { label: group.label, entries }
    })
    .filter((group) => group.entries.length > 0)

  const uncategorized = primitiveRegistry.filter((entry) => !used.has(entry.display.pathSegment))
  if (uncategorized.length > 0) {
    groups.push({ label: 'Other', entries: uncategorized })
  }

  return groups
}
