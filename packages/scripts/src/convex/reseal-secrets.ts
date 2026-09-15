#!/usr/bin/env bun

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
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
  const namespace = process.env.CONVEX_NAMESPACE ?? 'convex'

  const instanceName = process.env.INSTANCE_NAME ?? 'convex-self-hosted'
  const instanceSecret = process.env.INSTANCE_SECRET ?? generateHex(32)
  const adminKey = process.env.ADMIN_KEY ?? generateHex(64)

  const outputPath =
    process.env.CONVEX_SEALED_SECRET_OUTPUT ?? resolve(repoRoot, 'argocd/applications/convex/backend-sealedsecret.yaml')

  const sealed = await sealSecret({
    name: 'convex-backend-secrets',
    namespace,
    literals: [
      ['INSTANCE_NAME', instanceName],
      ['INSTANCE_SECRET', instanceSecret],
      ['ADMIN_KEY', adminKey],
    ],
    controllerName,
    controllerNamespace,
  })

  await writeFile(outputPath, sealed)

  console.log(`Sealed secret written to ${outputPath}`)
  console.log('Values used (store securely):')
  console.log(`  INSTANCE_NAME=${instanceName}`)
  console.log(`  INSTANCE_SECRET=${instanceSecret}`)
  console.log(`  ADMIN_KEY=${adminKey}`)
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to reseal convex secrets', error))
}

export const __private = { capture, generateHex, sealSecret, writeFile }
