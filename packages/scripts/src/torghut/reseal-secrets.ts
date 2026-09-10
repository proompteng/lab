#!/usr/bin/env bun

import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { $ } from 'bun'
import { ensureCli, fatal, repoRoot } from '../shared/cli'

const capture = async (cmd: string[], input?: string): Promise<string> => {
  const proc = Bun.spawn(cmd, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (input) {
    void proc.stdin?.write(input)
  }
  void proc.stdin?.end()

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  if (exitCode !== 0) {
    fatal(`Command failed (${exitCode}): ${cmd.join(' ')}`, stderr)
  }

  return stdout
}

const readOpSecret = async (path: string): Promise<string> => {
  try {
    const value = await $`op read ${path}`.text()
    const trimmed = value.trim()
    if (!trimmed) {
      fatal(`Secret at 1Password path '${path}' is empty`)
    }
    return trimmed
  } catch (error) {
    fatal(`Failed to read 1Password secret: ${path}`, error)
  }
}

type SecretOptions = {
  name: string
  namespace: string
  literals: Array<[string, string]>
  controllerName: string
  controllerNamespace: string
}

const sealSecret = async (options: SecretOptions): Promise<string> => {
  const command = [
    'kubectl',
    'create',
    'secret',
    'generic',
    options.name,
    '--namespace',
    options.namespace,
    '--dry-run=client',
    '-o',
    'json',
    ...options.literals.map(([key, value]) => `--from-literal=${key}=${value}`),
  ]

  const manifest = await capture(command)

  return await capture(
    [
      'kubeseal',
      '--name',
      options.name,
      '--namespace',
      options.namespace,
      '--controller-name',
      options.controllerName,
      '--controller-namespace',
      options.controllerNamespace,
      '--format',
      'yaml',
    ],
    manifest,
  )
}

export const main = async () => {
  ensureCli('op')
  ensureCli('kubectl')
  ensureCli('kubeseal')

  const outputPath = resolve(
    process.env.TORGHUT_SEALED_SECRET_OUTPUT ?? resolve(repoRoot, 'argocd/applications/torghut/sealed-secrets.yaml'),
  )

  const controllerName = process.env.SEALED_SECRETS_CONTROLLER_NAME ?? 'sealed-secrets'
  const controllerNamespace = process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE ?? 'sealed-secrets'

  const keyPath = process.env.TORGHUT_APCA_KEY_OP_PATH ?? 'op://infra/alpaca/key'
  const secretPath = process.env.TORGHUT_APCA_SECRET_OP_PATH ?? 'op://infra/alpaca/secret'
  const baseUrl = process.env.TORGHUT_APCA_BASE_URL ?? 'https://paper-api.alpaca.markets/v2'

  const key = await readOpSecret(keyPath)
  const secret = await readOpSecret(secretPath)

  const sealed = await sealSecret({
    name: 'torghut-alpaca',
    namespace: 'torghut',
    literals: [
      ['APCA_API_KEY_ID', key],
      ['APCA_API_SECRET_KEY', secret],
      ['APCA_API_BASE_URL', baseUrl],
    ],
    controllerName,
    controllerNamespace,
  })

  mkdirSync(dirname(outputPath), { recursive: true })
  const trimmed = sealed.trim()
  const content = trimmed.startsWith('---') ? `${trimmed}\n` : `---\n${trimmed}\n`
  await Bun.write(outputPath, content)
  chmodSync(outputPath, 0o600)
  console.log(`Torghut Alpaca SealedSecret written to ${outputPath}`)
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to reseal torghut secrets', error))
}

export const __private = {
  capture,
  readOpSecret,
  sealSecret,
}
