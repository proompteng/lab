import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import type { RepoContextResponse } from '@proompteng/agent-contracts'

import { getFlagValue, parseCliFlags } from './cli'

const flags = parseCliFlags(process.argv.slice(2))
const checkout = spawnSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' })
const expectedCommit = getFlagValue(flags, 'expected-commit') ?? checkout.stdout.trim()
if (!/^[0-9a-f]{40}$/.test(expectedCommit))
  throw new Error('Provide --expected-commit or fetch origin/main before evaluation.')
const cases = [
  {
    name: 'Shell implementation',
    query: 'Agent Shell memory tools',
    path: 'services/agents/',
    codePath: 'services/agents/src/server/agents-shell/tools/memory.ts',
  },
  {
    name: 'Partial database reads',
    query: 'native arrival copy psql partial stdout verification',
    memoryCommit: 'e3cb28786a67bcdf694bf87d061b2f9cc5b391e0',
  },
  {
    name: 'Valkey promotion',
    query: 'Valkey FAILOVER operator reverts primary promotion',
    memoryCommit: 'b5402c70f13eebf03f495c28a479da92b7f82d8a',
  },
  { name: 'Stale checkout', query: 'Agent Shell memory tools', stale: true },
]
let failures = 0
for (const test of cases) {
  const start = performance.now()
  const args = [
    process.execPath,
    fileURLToPath(new URL('./context.ts', import.meta.url)),
    '--query',
    test.query,
    '--expected-commit',
    test.stale ? '0'.repeat(40) : expectedCommit,
    '--json',
  ]
  if (test.path) args.push('--path', test.path)
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const [output, errors, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`Context CLI failed for ${test.name}: ${errors}`)
  const result = JSON.parse(output) as RepoContextResponse
  const passed = test.stale
    ? result.code.state === 'stale' &&
      result.code.items.length === 0 &&
      result.memory.state === 'ready' &&
      !result.snapshotVerified
    : result.snapshotVerified &&
      result.code.state === 'ready' &&
      result.memory.state === 'ready' &&
      (!test.codePath || result.code.items.some((item) => item.path === test.codePath)) &&
      (!test.memoryCommit || result.memory.items[0]?.commit === test.memoryCommit)
  if (!passed) failures++
  console.log(
    JSON.stringify({
      name: test.name,
      passed,
      code: result.code.state,
      memory: result.memory.state,
      bytes: Buffer.byteLength(output),
      elapsedMs: Math.round(performance.now() - start),
    }),
  )
}
if (failures) throw new Error(`${failures} repository context evaluations failed`)
