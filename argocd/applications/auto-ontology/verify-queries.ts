import { createAutoOntologyUpstream } from '../../../services/agents/src/auto-ontology-mcp/upstream'

const cases = [
  { term: 'Agent Run', time: 'created_at', relation: 'agents_audit.agent_runs' },
  { term: 'Broker Event', time: 'occurred_at', relation: 'public.broker_events' },
] as const

const counts = Bun.argv.slice(2)
if (counts.length !== cases.length || !counts.every((count) => /^(0|[1-9]\d*)$/.test(count))) {
  throw new Error('Pass the independently queried Agents and Bayn counts in that order (see README).')
}
const token = process.env.AUTO_ONTOLOGY_API_TOKEN
if (!token) throw new Error('Set AUTO_ONTOLOGY_API_TOKEN to a read/chat token.')
const upstream = createAutoOntologyUpstream({
  url: new URL('https://auto-ontology.ide-newton.ts.net'),
  token,
  maxResponseBytes: 2 * 1024 * 1024,
  timeoutMs: 30_000,
  chatTimeoutMs: 600_000,
})

for (const [i, { term, time, relation }] of cases.entries()) {
  const question = `How many ${term} records have ${time} strictly before 2026-11-26 00:00 UTC? Return one count.`
  const answer = await upstream.askQuestion({ question }, AbortSignal.timeout(600_000))
  const source = answer.sql.replaceAll('"', '').toLowerCase()
  const values = Object.values(answer.rows[0] ?? {})
  if (
    !source.includes(relation) ||
    !source.includes(time) ||
    answer.row_count !== 1 ||
    values.length !== 1 ||
    String(values[0]) !== counts[i]
  ) {
    throw new Error(`${term} failed source or count verification. Expected ${relation} and ${counts[i]}.`)
  }
  console.log(`${term}: ${relation}, ${counts[i]} verified.`)
}
