import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = join(import.meta.dir, '../../argocd/applications/hermes/bootstrap-lab-checkout.sh')

async function git(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(['git', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  }
  return stdout.trim()
}

async function runCheckout(
  repository: string,
  checkout: string,
  revisionFile: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(['/bin/sh', script], {
    env: {
      ...processEnv,
      GIT_TERMINAL_PROMPT: '0',
      LAB_REPOSITORY_URL: repository,
      LAB_CHECKOUT_REF: 'main',
      LAB_CHECKOUT_DIR: checkout,
      LAB_CHECKOUT_REVISION_FILE: revisionFile,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

const processEnv = { ...Bun.env }

test('creates, fast-forwards, and preserves a dirty lab checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-lab-checkout-'))
  const source = join(root, 'source')
  const checkout = join(root, 'checkout')
  const revisionFile = join(root, 'lab-source-revision')

  try {
    await git(root, 'init', '--initial-branch=main', source)
    await git(source, 'config', 'user.name', 'Hermes Test')
    await git(source, 'config', 'user.email', 'hermes-test@example.invalid')
    await writeFile(join(source, 'README.md'), 'first\n')
    await git(source, 'add', 'README.md')
    await git(source, 'commit', '-m', 'first')

    const initial = await runCheckout(source, checkout, revisionFile)
    expect(initial.exitCode).toBe(0)
    expect(initial.stdout).toContain('lab_checkout_ready=true')
    expect(await readFile(join(checkout, 'README.md'), 'utf8')).toBe('first\n')
    expect((await readFile(revisionFile, 'utf8')).trim()).toBe(await git(source, 'rev-parse', 'HEAD'))

    await writeFile(join(source, 'README.md'), 'second\n')
    await git(source, 'add', 'README.md')
    await git(source, 'commit', '-m', 'second')
    const refreshed = await runCheckout(source, checkout, revisionFile)
    expect(refreshed.exitCode).toBe(0)
    expect(await readFile(join(checkout, 'README.md'), 'utf8')).toBe('second\n')

    await writeFile(join(checkout, 'README.md'), 'local work\n')
    await writeFile(join(source, 'README.md'), 'third\n')
    await git(source, 'add', 'README.md')
    await git(source, 'commit', '-m', 'third')
    const preserved = await runCheckout(source, checkout, revisionFile)
    expect(preserved.exitCode).toBe(0)
    expect(preserved.stdout).toContain('preserving local lab checkout state')
    expect(await readFile(join(checkout, 'README.md'), 'utf8')).toBe('local work\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
