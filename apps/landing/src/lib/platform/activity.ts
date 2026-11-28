import { z } from 'zod'

const resource = z.object({ kind: z.string(), id: z.string(), target: z.string().optional() })
const command = z.object({
  resource: resource.optional(),
  resources: z.array(resource).optional(),
  relationships: z
    .array(
      z.object({
        resource,
        relation: z.string(),
        subject_kind: z.string(),
        subject_id: z.string(),
        enabled: z.boolean(),
      }),
    )
    .optional(),
})

// Historical command receipts contain serialized requests. Never dump those requests into the UI:
// expose only the resource/grant fields, not session IDs, bindings or future credential fields.
export function activityResources(values: string[]) {
  return values.flatMap((value) => {
    if (!value.startsWith('{')) return [value]
    try {
      const envelope = z.record(z.string(), z.unknown()).parse(JSON.parse(value))
      return Object.values(envelope).flatMap((payload) => {
        const parsed = command.safeParse(payload)
        if (!parsed.success) return []
        const detail = parsed.data
        const resources = [...(detail.resources || []), ...(detail.resource ? [detail.resource] : [])]
        return [
          ...resources.map((item) => `${item.kind}/${item.id}${item.target ? '#' + item.target : ''}`),
          ...(detail.relationships || []).map(
            (item) =>
              `${item.enabled ? 'Grant' : 'Revoke'} ${item.relation.replaceAll('_', ' ')} · ${item.resource.kind}/${item.resource.id} · ${item.subject_kind}/${item.subject_id}`,
          ),
        ]
      })
    } catch {
      return ['Resource details unavailable for this receipt']
    }
  })
}
