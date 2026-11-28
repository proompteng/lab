import { spawnSync } from 'node:child_process'

import { parseRepoContextInput, retrieveRepoContextFromAgentsService } from '@proompteng/agent-contracts'

import { getFlagValue, parseCliFlags, parseCommaList, resolveAgentsBaseUrl } from './cli'

const flags = parseCliFlags(process.argv.slice(2))
const supported = new Set([
  'query',
  'query-file',
  'repository',
  'expected-commit',
  'path',
  'tags',
  'limit',
  'max-bytes',
  'json',
])
for (const key of Object.keys(flags)) if (!supported.has(key)) throw new Error(`unsupported flag --${key}`)
const file = getFlagValue(flags, 'query-file')
const checkout = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const parsed = parseRepoContextInput({
  query: getFlagValue(flags, 'query') ?? (file ? await Bun.file(file).text() : ''),
  repository: getFlagValue(flags, 'repository'),
  expectedCommit:
    getFlagValue(flags, 'expected-commit') ?? (checkout.status === 0 ? checkout.stdout.trim() : undefined),
  pathPrefix: getFlagValue(flags, 'path'),
  tags: parseCommaList(getFlagValue(flags, 'tags')),
  limit: getFlagValue(flags, 'limit'),
  maxBytes: getFlagValue(flags, 'max-bytes'),
})
if (!parsed.ok) throw new Error(parsed.message)
const response = await retrieveRepoContextFromAgentsService(parsed.value, {
  ...process.env,
  AGENTS_SERVICE_BASE_URL: resolveAgentsBaseUrl(),
})
if (!response.ok) throw new Error(`Context retrieval failed (${response.status}): ${response.error}`)
const context = response.body
if (flags.json === true) {
  console.log(JSON.stringify(context))
} else {
  console.log(`${context.repository}: code ${context.code.state}, memory ${context.memory.state}`)
  console.log(
    `checkout ${context.expectedCommit ?? 'unknown'}; indexed ${context.indexedCommit ?? 'unknown'}; snapshot ${context.snapshotVerified ? 'verified' : 'unverified'}`,
  )
  if (context.code.state === 'ready') {
    for (const hit of context.code.items) {
      console.log(
        `\n${hit.path}:${hit.startLine ?? '?'}-${hit.endLine ?? '?'} @ ${hit.commit}\n${hit.excerpt}${hit.truncated ? '\n[excerpt truncated; read the source file]' : ''}`,
      )
    }
    if (context.code.omitted) console.log(`[${context.code.omitted} code hits omitted for the output budget]`)
  } else console.log(`Code: ${context.code.message}`)
  if (context.memory.state === 'ready') {
    for (const note of context.memory.items) {
      console.log(
        `\nMemory ${note.id} · ${note.createdAt} · commit ${note.commit ?? 'unrecorded'}\n${note.summary}\n${note.excerpt}${note.truncated ? `\n[excerpt truncated; read with bun run --cwd services/memories retrieve-memory --id ${note.id}]` : ''}`,
      )
    }
    if (context.memory.omitted) console.log(`[${context.memory.omitted} notes omitted for the output budget]`)
  } else console.log(`Memory: ${context.memory.message}`)
}
if (context.code.state !== 'ready' && context.memory.state !== 'ready') process.exitCode = 1
