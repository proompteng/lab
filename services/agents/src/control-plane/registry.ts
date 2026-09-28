import { controlPlanePrimitiveRegistry, type ControlPlanePrimitiveRegistryEntry } from './primitive-registry.generated'

export const primitiveRegistry = controlPlanePrimitiveRegistry

export const findPrimitiveDefinition = (rawKind?: string | null): ControlPlanePrimitiveRegistryEntry | null => {
  const normalized = rawKind?.trim().toLowerCase()
  if (!normalized) return null
  return (
    primitiveRegistry.find(
      (entry) =>
        entry.kind.toLowerCase() === normalized ||
        entry.display.pathSegment.toLowerCase() === normalized ||
        entry.plural.toLowerCase() === normalized,
    ) ?? null
  )
}
