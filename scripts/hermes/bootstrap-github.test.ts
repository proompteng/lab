import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const temporaryDirectories: string[] = []
const bootstrapScript = 'argocd/applications/hermes/bootstrap-github.sh'

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

async function run(command: string[], environment?: Record<string, string>): Promise<string> {
  const process = Bun.spawn(command, {
    env: environment ? { ...Bun.env, ...environment } : Bun.env,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed (${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  return stdout
}

test('installs a verified GitHub CLI archive and recreates deterministic Git configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-github-bootstrap-'))
  temporaryDirectories.push(root)

  const version = '9.9.9'
  const archiveRootName = `gh_${version}_linux_amd64`
  const sourceRoot = join(root, 'source')
  const fakeGhDirectory = join(sourceRoot, archiveRootName, 'bin')
  const fakeGh = join(fakeGhDirectory, 'gh')
  const archive = join(root, `${archiveRootName}.tar.gz`)
  const home = join(root, 'home')
  const tools = join(root, 'tools')
  const cache = join(root, 'cache')
  const testTmp = join(root, 'tmp')
  const installedGh = join(tools, 'gh')
  const gitConfig = join(home, '.gitconfig')

  await Promise.all([
    mkdir(fakeGhDirectory, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(tools, { recursive: true }),
    mkdir(cache, { recursive: true }),
    mkdir(testTmp, { recursive: true }),
  ])
  await writeFile(fakeGh, `#!/bin/sh\nprintf 'gh version ${version} (test)\\n'\n`)
  await chmod(fakeGh, 0o755)
  await run(['tar', '-czf', archive, '-C', sourceRoot, archiveRootName])

  const checksum = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex')
  const python = Bun.which('python3')
  if (!python) throw new Error('python3 is required for the GitHub bootstrap test')

  const environment = {
    GH_CLI_ARCHIVE_SHA256: checksum,
    GH_CLI_ARCHIVE_URL: pathToFileURL(archive).href,
    GH_CLI_CACHE_DIR: cache,
    GH_CLI_INSTALL_PATH: installedGh,
    GH_CLI_VERSION: version,
    HERMES_GIT_CONFIG_PATH: gitConfig,
    HERMES_PYTHON_BIN: python,
    HOME: home,
    TMPDIR: testTmp,
  }

  expect(await run(['/bin/sh', bootstrapScript], environment)).toContain(
    `github_bootstrap_ready=true gh_version=${version} git_user=tuslagch`,
  )
  expect((await stat(installedGh)).mode & 0o777).toBe(0o555)
  expect(await run([installedGh, '--version'])).toContain(`gh version ${version}`)
  expect(await run(['git', 'config', '--file', gitConfig, 'user.name'])).toBe('tuslagch\n')
  expect(await run(['git', 'config', '--file', gitConfig, 'user.email'])).toBe(
    '241203724+tuslagch@users.noreply.github.com\n',
  )
  expect(await run(['git', 'config', '--file', gitConfig, 'commit.gpgsign'])).toBe('false\n')
  expect(
    await run(['git', 'config', '--file', gitConfig, '--get-all', 'credential.https://github.com.helper']),
  ).toContain(`!${installedGh} auth git-credential`)
  expect(await readFile(gitConfig, 'utf8')).not.toMatch(/gh[opsu]_[A-Za-z0-9]+/)

  await chmod(installedGh, 0o755)
  await writeFile(installedGh, 'corrupt')
  await run(['/bin/sh', bootstrapScript], environment)
  expect(await run([installedGh, '--version'])).toContain(`gh version ${version}`)
})
