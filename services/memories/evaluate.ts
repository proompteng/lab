import { fileURLToPath } from 'node:url'

export const memoryEvaluationCases = [
  {
    name: 'MCTS evidence',
    query: 'MCTS selected expression wrong metrics multiple designs candidate evidence',
    commit: '25c8b43d7e5343fb8c9d75050569ddea12d3323b',
  },
  {
    name: 'MCTS paraphrase',
    query: 'MCTS selects a formula but reads another designs metrics',
    commit: '25c8b43d7e5343fb8c9d75050569ddea12d3323b',
  },
  {
    name: 'Arrival copy read failure',
    query: 'native arrival copy psql fails partial stdout verification',
    commit: 'e3cb28786a67bcdf694bf87d061b2f9cc5b391e0',
  },
  {
    name: 'Partial output paraphrase',
    query: 'copy verification returns partial database output',
    commit: 'e3cb28786a67bcdf694bf87d061b2f9cc5b391e0',
  },
  {
    name: 'Valkey failover',
    query: 'Valkey FAILOVER operator reverts primary promotion',
    commit: 'b5402c70f13eebf03f495c28a479da92b7f82d8a',
  },
  {
    name: 'Redis paraphrase',
    query: 'redis primary promotion gets undone',
    commit: 'b5402c70f13eebf03f495c28a479da92b7f82d8a',
  },
  { name: 'Unrelated request', query: 'kitchen faucet dishwasher filter replacement', commit: null },
]
if (import.meta.main) {
  let failures = 0
  for (const test of memoryEvaluationCases) {
    const start = performance.now()
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./retrieve.ts', import.meta.url)),
        '--query',
        test.query,
        '--limit',
        '5',
        '--json',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [output, errors, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error(`CLI failed for ${test.name}: ${errors}`)
    const body = JSON.parse(output) as { memories: Array<{ metadata: { commit?: string }; tags: string[] }> }
    const rank = test.commit ? body.memories.findIndex((row) => row.metadata.commit === test.commit) + 1 : null
    const unrelated = body.memories.some((row) => row.tags.includes('synthesis') || row.tags.includes('agentrun'))
    const passed = test.commit ? rank === 1 && !unrelated : body.memories.length === 0
    if (!passed) failures++
    console.log(
      JSON.stringify({
        name: test.name,
        passed,
        expectedRank: rank,
        returned: body.memories.length,
        elapsedMs: Math.round(performance.now() - start),
      }),
    )
  }
  if (failures) throw new Error(`${failures} memory retrieval evaluations failed`)
}
