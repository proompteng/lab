#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { ensureCli, fatal, run } from '../shared/cli'

const readEnv = (key: string, fallback?: string) => {
  const value = process.env[key]?.trim()
  return value && value.length > 0 ? value : fallback
}

const main = async () => {
  ensureCli('kubectl')

  const kubeconfigPath = readEnv('KUBECONFIG', resolve(homedir(), '.kube', 'config'))
  const contextName = readEnv('KUBE_CONTEXT_NAME', 'in-cluster')
  const clusterName = readEnv('KUBE_CLUSTER_NAME', 'in-cluster')
  const namespace = readEnv('KUBE_NAMESPACE', 'default')

  const tokenFile = readEnv('KUBE_TOKEN_FILE', '/var/run/secrets/kubernetes.io/serviceaccount/token')
  const caFile = readEnv('KUBE_CA_FILE', '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt')

  const serviceHost = readEnv('KUBERNETES_SERVICE_HOST')
  const servicePort = readEnv('KUBERNETES_SERVICE_PORT')

  if (!serviceHost || !servicePort) {
    fatal('KUBERNETES_SERVICE_HOST/PORT not set; not running in cluster?')
  }

  if (!tokenFile || !existsSync(tokenFile)) {
    fatal(`Service account token not found at ${tokenFile}`)
  }

  if (!caFile || !existsSync(caFile)) {
    fatal(`Service account CA not found at ${caFile}`)
  }

  await mkdir(dirname(kubeconfigPath), { recursive: true })

  const token = (await readFile(tokenFile, 'utf8')).trim()
  const server = `https://${serviceHost}:${servicePort}`

  await run('kubectl', [
    'config',
    'set-cluster',
    clusterName,
    `--server=${server}`,
    `--certificate-authority=${caFile}`,
    '--embed-certs=true',
    `--kubeconfig=${kubeconfigPath}`,
  ])

  await run('kubectl', [
    'config',
    'set-credentials',
    `${clusterName}-sa`,
    `--token=${token}`,
    `--kubeconfig=${kubeconfigPath}`,
  ])

  await run('kubectl', [
    'config',
    'set-context',
    contextName,
    `--cluster=${clusterName}`,
    `--user=${clusterName}-sa`,
    `--namespace=${namespace}`,
    `--kubeconfig=${kubeconfigPath}`,
  ])

  await run('kubectl', ['config', 'use-context', contextName, `--kubeconfig=${kubeconfigPath}`])

  console.log(`Kubeconfig written to ${kubeconfigPath} (context ${contextName})`)
}

await main()
