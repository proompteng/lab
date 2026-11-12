import { parseRetireMemoryNoteInput, retireMemoryNoteInAgentsService } from '@proompteng/agent-contracts'

import { getFlagValue, parseCliFlags, resolveAgentsBaseUrl } from './cli'

const flags = parseCliFlags(process.argv.slice(2))
const parsed = parseRetireMemoryNoteInput({
  id: getFlagValue(flags, 'id'),
  reason: getFlagValue(flags, 'reason'),
  replacementId: getFlagValue(flags, 'replacement-id'),
})
if (!parsed.ok) throw new Error(parsed.message)
const response = await retireMemoryNoteInAgentsService(parsed.value, {
  ...process.env,
  AGENTS_SERVICE_BASE_URL: resolveAgentsBaseUrl(),
})
if (!response.ok) throw new Error(`Agents memory retirement failed (${response.status}): ${response.error}`)
if (!response.body.ok) throw new Error('Agents memory API did not return success')
console.log(JSON.stringify(response.body, null, 2))
