import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  environment: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(['/bin/sh', script], {
    env: {
      ...processEnv,
      GIT_TERMINAL_PROMPT: '0',
      LAB_REPOSITORY_URL: repository,
      LAB_CHECKOUT_REF: 'main',
      LAB_CHECKOUT_DIR: checkout,
      LAB_CHECKOUT_REVISION_FILE: revisionFile,
      LAB_CHECKOUT_RETRY_ATTEMPTS: '3',
      LAB_CHECKOUT_RETRY_DELAY_SECONDS: '0',
      ...environment,
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
  const fakeBin = join(root, 'bin')
  const retryMarkers = join(root, 'retry-markers')
  const gitShim = join(fakeBin, 'git')

  try {
    await git(root, 'init', '--initial-branch=main', source)
    await git(source, 'config', 'user.name', 'Hermes Test')
    await git(source, 'config', 'user.email', 'hermes-test@example.invalid')
    await writeFile(join(source, 'README.md'), 'first\n')
    await git(source, 'add', 'README.md')
    await git(source, 'commit', '-m', 'first')

    const realGit = Bun.which('git')
    if (!realGit) throw new Error('git is required for the checkout bootstrap test')
    await Promise.all([mkdir(fakeBin), mkdir(retryMarkers)])
    await writeFile(
      gitShim,
      `#!/bin/sh
set -eu
for argument in "$@"; do
  case "$argument" in
    clone|fetch)
      marker="$GIT_RETRY_MARKER_DIR/$argument"
      if [ ! -e "$marker" ]; then
        : >"$marker"
        exit 1
      fi
      ;;
  esac
done
exec "$REAL_GIT" "$@"
`,
    )
    await chmod(gitShim, 0o755)
    const retryEnvironment = {
      GIT_RETRY_MARKER_DIR: retryMarkers,
      PATH: `${fakeBin}:${processEnv.PATH ?? ''}`,
      REAL_GIT: realGit,
    }

    const initial = await runCheckout(source, checkout, revisionFile, retryEnvironment)
    expect(initial.exitCode).toBe(0)
    expect(initial.stdout).toContain('lab_checkout_ready=true')
    expect(initial.stderr).toContain('lab checkout clone attempt 1/3 failed; retrying in 0s')
    expect(await readFile(join(checkout, 'README.md'), 'utf8')).toBe('first\n')
    expect((await readFile(revisionFile, 'utf8')).trim()).toBe(await git(source, 'rev-parse', 'HEAD'))

    await writeFile(join(source, 'README.md'), 'second\n')
    await git(source, 'add', 'README.md')
    await git(source, 'commit', '-m', 'second')
    const refreshed = await runCheckout(source, checkout, revisionFile, retryEnvironment)
    expect(refreshed.exitCode).toBe(0)
    expect(refreshed.stderr).toContain('lab checkout fetch attempt 1/3 failed; retrying in 0s')
    expect(await readFile(join(checkout, 'README.md'), 'utf8')).toBe('second\n')

    await writeFile(join(checkout, 'README.md'), 'local work\n')
    await writeFile(join(source, 'README.md'), 'third\n')
    await git(source, 'add', 'README.md')
    await git(source, 'commit', '-m', 'third')
    const preserved = await runCheckout(source, checkout, revisionFile, retryEnvironment)
    expect(preserved.exitCode).toBe(0)
    expect(preserved.stdout).toContain('preserving local lab checkout state')
    expect(await readFile(join(checkout, 'README.md'), 'utf8')).toBe('local work\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
