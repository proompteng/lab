import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Production uses Node; Bun substitutes an incomplete built-in Undici ProxyAgent.
test('Jev production proxy transport and scoped lifecycle under Node', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bayn-jev-http-'))
  try {
    const build = await Bun.build({
      entrypoints: [new URL('./http.test-support.ts', import.meta.url).pathname],
      outdir: directory,
      target: 'node',
    })
    if (!build.success) throw new AggregateError(build.logs, 'Jev Node transport proof did not compile')
    const child = Bun.spawn(['node', '--test', '--test-reporter=tap', join(directory, 'http.test-support.js')], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`Jev Node transport proof failed:\n${stdout}\n${stderr}`)
    expect(stdout).toContain('# pass 5')
    expect(stdout).toContain('# fail 0')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
