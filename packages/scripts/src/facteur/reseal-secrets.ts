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
    process.env.FACTEUR_SEALED_SECRETS_OUTPUT ??
      resolve(repoRoot, 'argocd/applications/facteur/overlays/cluster/secrets.yaml'),
  )

  const controllerName = process.env.SEALED_SECRETS_CONTROLLER_NAME ?? 'sealed-secrets'
  const controllerNamespace = process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE ?? 'sealed-secrets'

  const discordApplicationIdPath =
    process.env.FACTEUR_DISCORD_APPLICATION_ID_OP_PATH ?? 'op://infra/discord api token/application-id'
  const discordBotTokenPath = process.env.FACTEUR_DISCORD_BOT_TOKEN_OP_PATH ?? 'op://infra/discord api token/bot-token'

  const discordApplicationId = await readOpSecret(discordApplicationIdPath)
  const discordBotToken = await readOpSecret(discordBotTokenPath)

  const discordSecret = await sealSecret({
    name: 'facteur-discord',
    namespace: 'facteur',
    literals: [
      ['application-id', discordApplicationId],
      ['bot-token', discordBotToken],
    ],
    controllerName,
    controllerNamespace,
  })

  mkdirSync(dirname(outputPath), { recursive: true })
  const trimmed = discordSecret.trim()
  const content = trimmed.startsWith('---') ? `${trimmed}\n` : `---\n${trimmed}\n`
  await Bun.write(outputPath, content)
  chmodSync(outputPath, 0o600)
  console.log(`Discord SealedSecret written to ${outputPath}`)
  console.log(
    'Kafka credentials are managed by Strimzi; ensure the KafkaUser secret is synced to the facteur namespace.',
  )
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to reseal facteur secrets', error))
}

export const __private = {
  capture,
  readOpSecret,
  sealSecret,
}
