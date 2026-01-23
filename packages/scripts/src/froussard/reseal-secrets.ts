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

const writeDocuments = async (outputPath: string, documents: string[]) => {
  const content = documents
    .map((doc) => {
      const trimmed = doc.trim()
      return trimmed.startsWith('---') ? trimmed : `---\n${trimmed}`
    })
    .join('\n')

  mkdirSync(dirname(outputPath), { recursive: true })
  await Bun.write(outputPath, `${content}\n`)
  chmodSync(outputPath, 0o600)
}

export const main = async () => {
  ensureCli('op')
  ensureCli('kubectl')
  ensureCli('kubeseal')

  const githubOutputPath = resolve(
    process.env.FROUSSARD_GITHUB_SEALED_SECRETS_OUTPUT ??
      resolve(repoRoot, 'argocd/applications/froussard/github-secrets.yaml'),
  )
  const discordOutputPath = resolve(
    process.env.FROUSSARD_DISCORD_SEALED_SECRETS_OUTPUT ??
      resolve(repoRoot, 'argocd/applications/froussard/discord-secrets.yaml'),
  )

  const controllerName = process.env.SEALED_SECRETS_CONTROLLER_NAME ?? 'sealed-secrets'
  const controllerNamespace = process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE ?? 'sealed-secrets'

  const githubWebhookSecretPath =
    process.env.FROUSSARD_GITHUB_WEBHOOK_SECRET_OP_PATH ?? 'op://infra/github/webhook-secret'
  const githubTokenPath = process.env.FROUSSARD_GITHUB_TOKEN_OP_PATH ?? 'op://infra/github/personal-access-token'

  const discordPublicKeyPath = process.env.FROUSSARD_DISCORD_PUBLIC_KEY_OP_PATH ?? 'op://infra/discord/public-key'
  const discordBotTokenPath = process.env.FROUSSARD_CODEX_DISCORD_BOT_TOKEN_OP_PATH ?? 'op://infra/discord/bot-token'
  const discordGuildIdPath = process.env.FROUSSARD_CODEX_DISCORD_GUILD_ID_OP_PATH ?? 'op://infra/discord/guild-id'
  const discordCategoryIdPath =
    process.env.FROUSSARD_CODEX_DISCORD_CATEGORY_ID_OP_PATH ?? 'op://infra/discord/category-id'

  const githubWebhookSecret = await readOpSecret(githubWebhookSecretPath)
  const githubToken = await readOpSecret(githubTokenPath)

  const discordPublicKey = await readOpSecret(discordPublicKeyPath)
  const discordBotToken = await readOpSecret(discordBotTokenPath)
  const discordGuildId = await readOpSecret(discordGuildIdPath)

  let discordCategoryId: string | undefined
  if (discordCategoryIdPath) {
    try {
      const value = (await $`op read ${discordCategoryIdPath}`.text()).trim()
      if (value) {
        discordCategoryId = value
      } else {
        console.warn(`Discord category id at '${discordCategoryIdPath}' is empty; skipping field`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`Optional Discord category id not found at '${discordCategoryIdPath}': ${message}`)
    }
  }

  const githubSecrets = await Promise.all([
    sealSecret({
      name: 'github-secret',
      namespace: 'froussard',
      literals: [['webhook-secret', githubWebhookSecret]],
      controllerName,
      controllerNamespace,
    }),
    sealSecret({
      name: 'github-token',
      namespace: 'froussard',
      literals: [['token', githubToken]],
      controllerName,
      controllerNamespace,
    }),
    sealSecret({
      name: 'github-token',
      namespace: 'argo-workflows',
      literals: [['token', githubToken]],
      controllerName,
      controllerNamespace,
    }),
  ])

  const discordLiterals: Array<[string, string]> = [
    ['bot-token', discordBotToken],
    ['guild-id', discordGuildId],
  ]
  if (discordCategoryId) {
    discordLiterals.push(['category-id', discordCategoryId])
  }

  const discordSecrets = await Promise.all([
    sealSecret({
      name: 'discord-bot',
      namespace: 'froussard',
      literals: [['public-key', discordPublicKey]],
      controllerName,
      controllerNamespace,
    }),
    sealSecret({
      name: 'discord-codex-bot',
      namespace: 'argo-workflows',
      literals: discordLiterals,
      controllerName,
      controllerNamespace,
    }),
  ])

  await writeDocuments(githubOutputPath, githubSecrets)
  console.log(`GitHub SealedSecrets written to ${githubOutputPath}`)

  await writeDocuments(discordOutputPath, discordSecrets)
  console.log(`Discord SealedSecrets written to ${discordOutputPath}`)
  console.log(
    'Kafka credentials are sourced from the Strimzi-managed froussard KafkaUser secret; no sealed secret required.',
  )
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to reseal froussard secrets', error))
}

export const __private = {
  capture,
  readOpSecret,
  sealSecret,
  writeDocuments,
}
