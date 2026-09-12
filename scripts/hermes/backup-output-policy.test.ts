import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const policyScript = join(import.meta.dir, '../../argocd/applications/hermes/backup-output-policy.sh')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

async function runPolicy(output: string, hermesHome: string): Promise<number> {
  const process = Bun.spawn(
    [
      '/bin/sh',
      '-c',
      '. "$1"; hermes_backup_output_is_safe "$2" "$3"',
      'backup-policy-test',
      policyScript,
      output,
      hermesHome,
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  )
  await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()])
  return process.exited
}

async function createUnixSocket(path: string): Promise<Server> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  return server
}

function gatewaySocketWarning(hermesHome: string, warningCount = 1, extraWarning = ''): string {
  return [
    `Scanning ${hermesHome} ...`,
    'Backup incomplete: /opt/backups/.hermes-backup-test.zip',
    `  Warnings (${warningCount} files skipped):`,
    `  gateway.sock: [Errno 6] No such device or address: '${hermesHome}/gateway.sock'`,
    extraWarning,
  ]
    .filter(Boolean)
    .join('\n')
}

test('accepts a complete backup without warnings', async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-backup-policy-'))
  temporaryDirectories.push(hermesHome)

  expect(await runPolicy('Backup complete: /opt/backups/hermes-backup-test.zip', hermesHome)).toBe(0)
})

test('accepts only the exact live gateway socket omission', async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-backup-policy-'))
  temporaryDirectories.push(hermesHome)
  const server = await createUnixSocket(join(hermesHome, 'gateway.sock'))

  try {
    expect(await runPolicy(gatewaySocketWarning(hermesHome), hermesHome)).toBe(0)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test('rejects the gateway warning when the path is absent or a regular file', async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-backup-policy-'))
  temporaryDirectories.push(hermesHome)
  const warning = gatewaySocketWarning(hermesHome)

  expect(await runPolicy(warning, hermesHome)).toBe(1)
  await writeFile(join(hermesHome, 'gateway.sock'), 'not a socket')
  expect(await runPolicy(warning, hermesHome)).toBe(1)
})

test('rejects any additional skipped file', async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-backup-policy-'))
  temporaryDirectories.push(hermesHome)
  const server = await createUnixSocket(join(hermesHome, 'gateway.sock'))

  try {
    expect(await runPolicy(gatewaySocketWarning(hermesHome, 2, '  config.yaml: permission denied'), hermesHome)).toBe(1)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test('rejects database-copy failures even with the exact socket warning', async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-backup-policy-'))
  temporaryDirectories.push(hermesHome)
  const server = await createUnixSocket(join(hermesHome, 'gateway.sock'))

  try {
    const output = `${gatewaySocketWarning(hermesHome)}\n  state.db: SQLite safe copy failed`
    expect(await runPolicy(output, hermesHome)).toBe(1)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test('accepts both 0.21 runtime sockets and rejects every unaccounted warning', async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-policy-'))
  temporaryDirectories.push(hermesHome)
  await mkdir(join(hermesHome, 'state'))
  const gateway = await createUnixSocket(join(hermesHome, 'gateway.sock'))
  const loopPath = 'state/gateway.loop-tick.1.sock'
  const loop = await createUnixSocket(join(hermesHome, loopPath))
  const loopWarning = `  ${loopPath}: [Errno 6] No such device or address: '${hermesHome}/${loopPath}'`
  const output = gatewaySocketWarning(hermesHome, 2, loopWarning)
  try {
    expect(await runPolicy(output, hermesHome)).toBe(0)
    expect(await runPolicy(output.replace('(2 files', '(1 files'), hermesHome)).toBe(1)
    expect(await runPolicy(`${output}\n  state.db: permission denied`, hermesHome)).toBe(1)
    expect(await runPolicy(`${output}\n${loopWarning}`, hermesHome)).toBe(1)
    expect(await runPolicy(`${output}\n  Warnings (2 files skipped):`, hermesHome)).toBe(1)
    expect(await runPolicy(`${output}\nSQLite safe copy failed`, hermesHome)).toBe(1)
    expect(await runPolicy(`${output}\nRaw copy also failed`, hermesHome)).toBe(1)
  } finally {
    await Promise.all(
      [gateway, loop].map(
        (server) =>
          new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
      ),
    )
  }
  expect(await runPolicy(output, hermesHome)).toBe(1)
})

test('rejects regular files and symlinks at the loop-tick socket path', async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-policy-'))
  temporaryDirectories.push(hermesHome)
  await mkdir(join(hermesHome, 'state'))
  const gateway = await createUnixSocket(join(hermesHome, 'gateway.sock'))
  const loopPath = 'state/gateway.loop-tick.1.sock'
  const output = gatewaySocketWarning(
    hermesHome,
    2,
    `  ${loopPath}: [Errno 6] No such device or address: '${hermesHome}/${loopPath}'`,
  )
  try {
    expect(await runPolicy(output, hermesHome)).toBe(1)
    await writeFile(join(hermesHome, loopPath), 'not a socket')
    expect(await runPolicy(output, hermesHome)).toBe(1)
    await rm(join(hermesHome, loopPath))
    await symlink(join(hermesHome, 'gateway.sock'), join(hermesHome, loopPath))
    expect(await runPolicy(output, hermesHome)).toBe(1)
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((error) => (error ? reject(error) : resolve())))
  }
})
