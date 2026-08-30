#!/usr/bin/env bun

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ensureCli, fatal, repoRoot } from '../shared/cli'

const capture = async (cmd: string[], stdin?: string): Promise<string> => {
  const proc = Bun.spawn(cmd, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (stdin) {
    void proc.stdin?.write(stdin)
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

const generateHex = (bytes: number): string => randomBytes(bytes).toString('hex')
const generateBase64 = (bytes: number): string => randomBytes(bytes).toString('base64')

const readSecretFromFile = (path: string): string | null => {
  if (!existsSync(path)) return null
  const value = readFileSync(path, 'utf8').trim()
  return value ? value : null
}

const getOrPersistSecret = (path: string, generate: () => string): string => {
  const existing = readSecretFromFile(path)
  if (existing) return existing

  const value = generate()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${value}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return value
}

const requireEnvOrFile = (envKey: string, fileEnvKey: string, fallbackPath: string): string => {
  const value = process.env[envKey]?.trim()
  if (value) return value

  const fromFileEnv = process.env[fileEnvKey]?.trim()
  if (fromFileEnv) {
    const fromFile = readSecretFromFile(fromFileEnv)
    if (fromFile) return fromFile
    throw new Error(`${fileEnvKey} points to an empty or missing file: ${fromFileEnv}`)
  }

  const fallback = readSecretFromFile(fallbackPath)
  if (fallback) return fallback

  throw new Error(`Missing ${envKey}. Set ${envKey} or ${fileEnvKey}.`)
}

type SealOptions = {
  name: string
  namespace: string
  literals: Array<[string, string]>
  controllerName: string
  controllerNamespace: string
}

const sealSecret = async (options: SealOptions): Promise<string> => {
  const manifest = await capture([
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
  ])

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

const writeFile = async (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  await Bun.write(path, content.endsWith('\n') ? content : `${content}\n`)
  chmodSync(path, 0o600)
}

export const main = async () => {
  ensureCli('kubectl')
  ensureCli('kubeseal')

  const controllerName = process.env.SEALED_SECRETS_CONTROLLER_NAME ?? 'sealed-secrets'
  const controllerNamespace = process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE ?? 'sealed-secrets'
  const namespace = process.env.APP_NAMESPACE ?? 'app'

  const baseUrl = process.env.APP_BASE_URL ?? 'https://app.proompteng.ai'
  const issuerUrl = process.env.APP_OIDC_ISSUER_URL ?? 'https://auth.proompteng.ai/realms/master'
  const clientId = process.env.APP_OIDC_CLIENT_ID ?? 'proompteng-app'
  const allowedEmailDomain = process.env.APP_AUTH_ALLOWED_EMAIL_DOMAIN?.trim()
  const persistedDir = resolve(repoRoot, '.local/app-auth')

  const clientSecret = requireEnvOrFile(
    'APP_OIDC_CLIENT_SECRET',
    'APP_OIDC_CLIENT_SECRET_FILE',
    resolve(persistedDir, 'oidc-client-secret.txt'),
  )

  const betterAuthSecret =
    process.env.BETTER_AUTH_SECRET?.trim() ||
    getOrPersistSecret(resolve(persistedDir, 'better-auth-secret.txt'), () => generateBase64(48))

  const outputPath = process.env.APP_SEALED_SECRET_OUTPUT ?? resolve(repoRoot, 'argocd/applications/app/secret.yaml')

  const literals: Array<[string, string]> = [
    ['APP_BASE_URL', baseUrl],
    ['APP_OIDC_ISSUER_URL', issuerUrl],
    ['APP_OIDC_CLIENT_ID', clientId],
    ['APP_OIDC_CLIENT_SECRET', clientSecret],
    ['BETTER_AUTH_SECRET', betterAuthSecret],
  ]

  if (allowedEmailDomain) {
    literals.push(['APP_AUTH_ALLOWED_EMAIL_DOMAIN', allowedEmailDomain])
  }

  const sealed = await sealSecret({
    name: 'app-env',
    namespace,
    literals,
    controllerName,
    controllerNamespace,
  })

  await writeFile(outputPath, sealed)

  console.log(`Sealed secret written to ${outputPath}`)
  console.log(
    'Sealed keys: APP_BASE_URL, APP_OIDC_ISSUER_URL, APP_OIDC_CLIENT_ID, APP_OIDC_CLIENT_SECRET, BETTER_AUTH_SECRET',
  )
  if (allowedEmailDomain) console.log('Sealed key: APP_AUTH_ALLOWED_EMAIL_DOMAIN')
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to reseal app secrets', error))
}
