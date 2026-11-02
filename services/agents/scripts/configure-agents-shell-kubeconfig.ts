import { accessSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const configureAgentsShellKubeconfig = ({
  kubeconfigPath,
  server,
  serviceAccountDirectory,
}: {
  kubeconfigPath: string
  server: string
  serviceAccountDirectory: string
}) => {
  const endpoint = new URL(server)
  if (endpoint.protocol !== 'https:') throw new Error('agents-shell Kubernetes endpoint must use HTTPS')

  const tokenFile = join(serviceAccountDirectory, 'token')
  const certificateAuthority = join(serviceAccountDirectory, 'ca.crt')
  accessSync(tokenFile)
  accessSync(certificateAuthority)
  const namespace = readFileSync(join(serviceAccountDirectory, 'namespace'), 'utf8').trim()
  if (!namespace) throw new Error('agents-shell ServiceAccount namespace is empty')

  const kubeconfig = {
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name: 'in-cluster', cluster: { server, 'certificate-authority': certificateAuthority } }],
    users: [{ name: 'service-account', user: { tokenFile } }],
    contexts: [{ name: 'in-cluster', context: { cluster: 'in-cluster', user: 'service-account', namespace } }],
    'current-context': 'in-cluster',
  }
  mkdirSync(dirname(kubeconfigPath), { recursive: true })
  writeFileSync(kubeconfigPath, `${JSON.stringify(kubeconfig)}\n`, { mode: 0o600 })
  chmodSync(kubeconfigPath, 0o600)
}

if (import.meta.main) {
  const kubeconfigPath = process.env.KUBECONFIG
  const host = process.env.KUBERNETES_SERVICE_HOST
  const port = process.env.KUBERNETES_SERVICE_PORT
  if (!kubeconfigPath || !host || !port)
    throw new Error('agents-shell in-cluster Kubernetes configuration is incomplete')

  configureAgentsShellKubeconfig({
    kubeconfigPath,
    server: `https://${host.includes(':') ? `[${host}]` : host}:${port}`,
    serviceAccountDirectory: '/var/run/secrets/kubernetes.io/serviceaccount',
  })
}
