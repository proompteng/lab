import { createHash } from 'node:crypto'
import {
  normalizeMemoryNoteNamespace,
  normalizeMemoryNoteTags,
  stableJsonStringifyForHash,
  type AgentsPersistMemoryNoteInput,
} from '@proompteng/agent-contracts'

export const resolveMemoryNoteSave = (input: AgentsPersistMemoryNoteInput) => {
  const namespace = normalizeMemoryNoteNamespace(input.namespace)
  const content = input.content.trim()
  if (!content) throw new Error('content is required')
  const providedSummary = input.summary == null ? null : input.summary.trim()
  const summary = providedSummary ?? content.slice(0, 300)
  const tags = [...new Set(normalizeMemoryNoteTags(input.tags))].sort()
  const metadataJson = JSON.stringify({ ...input.metadata, namespace })
  const saveKey = createHash('sha256')
    .update(
      stableJsonStringifyForHash({
        namespace,
        content,
        summary,
        tags,
        metadata: JSON.parse(metadataJson),
      }),
    )
    .digest('hex')
  return {
    namespace,
    content,
    summary,
    tags,
    metadataJson,
    saveKey,
    embeddingText: providedSummary ? `${providedSummary}\n\n${content}` : content,
  }
}
