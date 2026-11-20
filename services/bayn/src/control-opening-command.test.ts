import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'

import { runControlOpeningCommand } from './control-opening-command'

test('native opening help works without credentials or resource acquisition', async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/control-opening-command.ts`, '--help'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exitCode).toBe(0)
  expect(stdout).toContain('Usage: bayn-control-opening --plan')
  expect(stderr).toBe('')
})

test.each([[], ['--help', '--output', '/tmp/unused'], ['--plan', 'x', '--plan-sha256', 'bad', '--output', 'x']])(
  'invalid opening arguments fail before loading runtime configuration',
  async (...args) => {
    const exit = await Effect.runPromiseExit(runControlOpeningCommand(args).pipe(Effect.provide(NodeServices.layer)))
    expect(exit._tag).toBe('Failure')
    expect(String(exit)).toContain('Usage: bayn-control-opening')
  },
)
