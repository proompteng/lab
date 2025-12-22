#!/usr/bin/env bun

import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'

const capture = async (cmd: string[], input?: string): Promise<string> => {
  const proc = Bun.spawn(cmd, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (input) {
    proc.stdin?.write(input)
  }
  proc.stdin?.end()

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

type SealOptions = {
  name: string
  namespace: string
  certPath: string
  keyPath: string
  controllerName: string
  controllerNamespace: string
}

const sealTlsSecret = async (options: SealOptions): Promise<string> => {
  const manifest = await capture([
    'kubectl',
    'create',
    'secret',
    'tls',
    options.name,
    '--namespace',
    options.namespace,
    '--cert',
    options.certPath,
    '--key',
    options.keyPath,
    '--dry-run=client',
    '-o',
    'json',
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

const getProxyPod = async (namespace: string, selectors: string[]): Promise<string> => {
  for (const selector of selectors) {
    const pod = (
      await capture([
        'kubectl',
        'get',
        'pods',
        '-n',
        namespace,
        '-l',
        selector,
        '-o',
        'jsonpath={.items[0].metadata.name}',
      ])
    ).trim()
    if (pod) {
      return pod
    }
  }

  fatal(`No Tailscale proxy pod found in ${namespace} with selectors: ${selectors.join(' | ')}`)
}

export const main = async () => {
  ensureCli('kubectl')
  ensureCli('kubeseal')

  const hostname = process.env.HEADLAMP_TAILSCALE_HOSTNAME ?? 'headlamp.ide-newton.ts.net'
  const namespace = process.env.HEADLAMP_NAMESPACE ?? 'headlamp'
  const secretName = process.env.HEADLAMP_TLS_SECRET_NAME ?? 'headlamp-tls'
  const tailscaleNamespace = process.env.HEADLAMP_TAILSCALE_NAMESPACE ?? 'tailscale'
  const labelSelector = process.env.HEADLAMP_TAILSCALE_LABEL_SELECTOR
  const explicitPod = process.env.HEADLAMP_TAILSCALE_POD
  const outputPath = resolve(
    process.env.HEADLAMP_TLS_SEALED_SECRET_OUTPUT ??
      resolve(repoRoot, 'argocd/applications/headlamp/headlamp-tls-sealedsecret.yaml'),
  )

  const controllerName = process.env.SEALED_SECRETS_CONTROLLER_NAME ?? 'sealed-secrets'
  const controllerNamespace = process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE ?? 'sealed-secrets'

  const tempDir = mkdtempSync(resolve(tmpdir(), 'headlamp-tls-'))
  const certPath = resolve(tempDir, 'tls.crt')
  const keyPath = resolve(tempDir, 'tls.key')

  try {
    const selectors = labelSelector
      ? [labelSelector]
      : [
          'tailscale.com/parent-resource=headlamp,tailscale.com/parent-resource-ns=headlamp,tailscale.com/parent-resource-type=ingress',
          'tailscale.com/parent-resource=headlamp,tailscale.com/parent-resource-ns=headlamp,tailscale.com/parent-resource-type=svc',
        ]
    const podName = explicitPod ?? (await getProxyPod(tailscaleNamespace, selectors))
    const remoteDir = `/tmp/headlamp-tls-${Date.now()}`
    const remoteCertPath = `${remoteDir}/tls.crt`
    const remoteKeyPath = `${remoteDir}/tls.key`

    await run('kubectl', [
      'exec',
      '-n',
      tailscaleNamespace,
      podName,
      '--',
      'sh',
      '-c',
      `mkdir -p ${remoteDir} && tailscale cert --cert-file ${remoteCertPath} --key-file ${remoteKeyPath} ${hostname}`,
    ])
    await run('kubectl', ['cp', '-n', tailscaleNamespace, `${podName}:${remoteCertPath}`, certPath])
    await run('kubectl', ['cp', '-n', tailscaleNamespace, `${podName}:${remoteKeyPath}`, keyPath])
    await run('kubectl', ['exec', '-n', tailscaleNamespace, podName, '--', 'rm', '-rf', remoteDir])

    const sealed = await sealTlsSecret({
      name: secretName,
      namespace,
      certPath,
      keyPath,
      controllerName,
      controllerNamespace,
    })

    mkdirSync(dirname(outputPath), { recursive: true })
    const trimmed = sealed.trim()
    const content = trimmed.startsWith('---') ? `${trimmed}\n` : `---\n${trimmed}\n`
    await Bun.write(outputPath, content)
    chmodSync(outputPath, 0o600)
    console.log(`Headlamp TLS SealedSecret written to ${outputPath}`)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to reseal headlamp TLS secret', error))
}

export const __private = {
  capture,
  sealTlsSecret,
}
