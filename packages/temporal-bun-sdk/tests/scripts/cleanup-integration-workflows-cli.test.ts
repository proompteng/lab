import { expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const query = 'WorkflowType="workerLoadActivityWorkflow" and ExecutionStatus="Running"'
for (const mode of ['zero', 'nonzero', 'malformed', 'error', 'ordinary'] as const) {
  test(`cleanup CLI preserves namespace and predicates when the list is ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'temporal-cleanup-race-'))
    const cli = join(root, 'temporal')
    const log = join(root, 'calls.jsonl')
    const source = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const log = ${JSON.stringify(log)}
const previous = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line)) : []
appendFileSync(log, JSON.stringify(args) + '\\n')
const query = args[args.indexOf('--query') + 1]
const mode = ${JSON.stringify(mode)}
if (args.includes('count')) {
  if (query !== ${JSON.stringify(query)}) console.log('Total: 0')
  else if (!previous.some(call => call.includes('count') && call.includes(query))) console.log('Total: 3')
  else if (mode === 'error') { console.error('count command failed'); process.exit(1) }
  else if (mode === 'malformed') console.log('not a count')
  else console.log(mode === 'nonzero' ? 'Total: 3' : 'Total: 0')
} else if (args.includes('list')) {
  if (mode === 'ordinary') console.log('Running closed-run workerLoadActivityWorkflow 1 minute ago')
} else if (args.includes('terminate') && mode === 'ordinary') {
  console.error('workflow execution already completed'); process.exit(1)
} else { console.error('Unexpected CLI operation'); process.exit(1) }
`
    await writeFile(cli, source)
    await chmod(cli, 0o755)
    try {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, '../../scripts/cleanup-integration-workflows.ts'), '--verify'],
        {
          env: {
            ...process.env,
            TEMPORAL_CLI_PATH: cli,
            TEMPORAL_ADDRESS: '127.0.0.1:1',
            TEMPORAL_NAMESPACE: 'effect4-cleanup-regression',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ])
      expect(exitCode).toBe(mode === 'zero' || mode === 'ordinary' ? 0 : 1)
      if (mode === 'malformed') expect(stderr).toContain('Unable to parse Temporal count output')
      if (mode === 'error') expect(stderr).toContain('count command failed')
      if (mode === 'nonzero') expect(stderr).toContain('workflows leaked after test cleanup')
      const calls: string[][] = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      for (const call of calls) {
        expect(call[call.indexOf('--namespace') + 1]).toBe('effect4-cleanup-regression')
        expect(call[call.indexOf('--address') + 1]).toBe('127.0.0.1:1')
      }
      const countCalls = calls.filter((call) => call.includes('count') && call.includes(query))
      expect(countCalls).toHaveLength(2)
      expect(countCalls[1]).toEqual(countCalls[0])
      const listCall = calls.find((call) => call.includes('list'))!
      expect(listCall[listCall.indexOf('--query') + 1]).toBe(query)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
