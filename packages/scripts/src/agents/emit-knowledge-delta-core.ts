import { validateAgentsOntologyAnalyses } from './agents-ontology-schema'
import { validateKnowledgeDelta } from './ontology-deltas'
import { formatOntologyJson, isJsonObject, maxOntologyJsonBytes } from './ontology-json'

const jsonStringCount = (text: string) => text.match(/"(?:[^"\\]|\\.)*"/g)?.length ?? 0

export const prepareKnowledgeDelta = async (
  source: string,
  { headCommit, check = false }: { headCommit: string; check?: boolean },
): Promise<string> => {
  if (headCommit.length !== 40 || !/^[a-f0-9]{40}$/.test(headCommit)) {
    throw new Error('Expected a full Git SHA for the checked-out commit')
  }
  if (Buffer.byteLength(source) > maxOntologyJsonBytes) throw new Error('Input JSON exceeds the 1 MiB size limit')

  let input: unknown
  try {
    input = JSON.parse(source)
  } catch {
    throw new Error('Invalid JSON')
  }
  const delta = validateKnowledgeDelta(
    !check && isJsonObject(input) ? { kind: 'knowledge-delta', version: 1, sourceCommit: headCommit, ...input } : input,
  )
  if (delta.sourceCommit !== headCommit) {
    throw new Error('sourceCommit: expected the full Git SHA of the checked-out commit')
  }

  // Each JSON key is a string token. Parsing duplicate keys drops at least one token.
  if (jsonStringCount(source) !== jsonStringCount(JSON.stringify(input))) throw new Error('Duplicate JSON key')

  const canonical = await formatOntologyJson(delta, true)
  if (Buffer.byteLength(canonical) > maxOntologyJsonBytes) throw new Error('Emitted JSON exceeds the 1 MiB size limit')
  if (check && source !== canonical) throw new Error('Expected canonical knowledge-delta JSON; re-emit the proposal')

  await validateAgentsOntologyAnalyses(delta.customAnalyses ?? [])
  return canonical
}
