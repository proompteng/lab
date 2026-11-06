import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

test('production Nix Node replays original v38 entry and exit bytes through retained financial readers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bayn-retained-v38-node-'))
  const sources = join(import.meta.dir, '../src/jev')
  const fixtures = join(sources, 'fixtures/retained-v38')
  try {
    const built = await Bun.build({
      entrypoints: [join(sources, 'retained-v38-node.test-support.ts')],
      target: 'node',
      outdir: directory,
      naming: 'verify.mjs',
      external: ['tigerbeetle-node', '@platformatic/kafka'],
    })
    if (!built.success) throw new AggregateError(built.logs, 'Retained Node verifier did not compile')
    const child = Bun.spawn(
      [
        'node',
        join(directory, 'verify.mjs'),
        join(fixtures, 'node-entry-equity.json.gz'),
        join(fixtures, 'node-exit-equity.json.gz'),
        join(fixtures, 'node-entry-ablation.json.gz'),
        join(fixtures, 'entry-momentum-document.json.gz'),
        join(fixtures, 'node-exit-ablation.json.gz'),
        join(fixtures, 'node-exit-momentum.json.gz'),
        join(fixtures, 'entry-crypto-node.json.gz'),
      ],
      { stdout: 'pipe', stderr: 'pipe', timeout: 10_000, killSignal: 'SIGKILL' },
    )
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
      const proof: unknown = JSON.parse(stdout)
      expect(proof).toMatchObject({ status: 'VERIFIED', caseCount: 7 })
      process.stdout.write(`Retained v38 production runtime: ${stdout}\n`)
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
