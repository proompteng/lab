import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

test('production Node replays original v38 entry and exit bytes through retained financial readers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bayn-retained-v38-node-'))
  try {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, 'retained-v38-node.test-support.ts')],
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
        join(import.meta.dir, 'fixtures/retained-v38/node-entry-equity.json.gz'),
        join(import.meta.dir, 'fixtures/retained-v38/node-exit-equity.json.gz'),
        join(import.meta.dir, 'fixtures/retained-v38/node-entry-ablation.json.gz'),
        join(import.meta.dir, 'fixtures/retained-v38/entry-momentum-document.json.gz'),
        join(import.meta.dir, 'fixtures/retained-v38/node-exit-ablation.json.gz'),
        join(import.meta.dir, 'fixtures/retained-v38/node-exit-momentum.json.gz'),
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
      expect(stdout).toBe('RETAINED_V38_NODE_ENTRY_EXIT_VERIFIED')
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
