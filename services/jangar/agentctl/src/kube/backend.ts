import { buildKubectlArgs, KubectlError, type KubectlOptions, runKubectl, runKubectlJson } from './kubectl'

export type KubeResourceSpec = {
  kind: string
  group: string
  version: string
  plural: string
}

export type KubeBackend = {
  readNamespace: (name: string) => Promise<Record<string, unknown>>
  listDeployments: (namespace: string, labelSelector?: string) => Promise<Record<string, unknown>>
  listCrds: () => Promise<Record<string, unknown>>
  listCustomObjects: (
    spec: KubeResourceSpec,
    namespace: string,
    labelSelector?: string,
  ) => Promise<Record<string, unknown>>
  getCustomObject: (spec: KubeResourceSpec, namespace: string, name: string) => Promise<Record<string, unknown>>
  createCustomObject: (
    spec: KubeResourceSpec,
    namespace: string,
    body: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  replaceCustomObject: (
    spec: KubeResourceSpec,
    namespace: string,
    name: string,
    body: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  deleteCustomObject: (spec: KubeResourceSpec, namespace: string, name: string) => Promise<Record<string, unknown>>
  listPods: (namespace: string, labelSelector?: string) => Promise<Record<string, unknown>>
  deleteJob: (namespace: string, name: string) => Promise<void>
  deleteJobsBySelector: (namespace: string, selector: string) => Promise<void>
  streamPodLogs: (namespace: string, podName: string, container?: string, follow?: boolean) => Promise<void>
}

const resourceRef = (spec: KubeResourceSpec) => `${spec.plural}.${spec.group}`

const withNamespace = (options: KubectlOptions, namespace?: string): KubectlOptions => ({
  kubeconfig: options.kubeconfig,
  context: options.context,
  namespace,
})

export const createKubectlBackend = (options: KubectlOptions): KubeBackend => ({
  readNamespace: (name) => runKubectlJson(['get', 'namespace', name, '-o', 'json'], withNamespace(options)),
  listDeployments: (namespace, labelSelector) => {
    const args = ['get', 'deployment', '-o', 'json']
    if (labelSelector) args.push('-l', labelSelector)
    return runKubectlJson(args, withNamespace(options, namespace))
  },
  listCrds: () => runKubectlJson(['get', 'crd', '-o', 'json'], withNamespace(options)),
  listCustomObjects: (spec, namespace, labelSelector) => {
    const args = ['get', resourceRef(spec), '-o', 'json']
    if (labelSelector) args.push('-l', labelSelector)
    return runKubectlJson(args, withNamespace(options, namespace))
  },
  getCustomObject: (spec, namespace, name) =>
    runKubectlJson(['get', resourceRef(spec), name, '-o', 'json'], withNamespace(options, namespace)),
  createCustomObject: (_spec, namespace, body) =>
    runKubectlJson(['create', '-f', '-', '-o', 'json'], withNamespace(options, namespace), JSON.stringify(body)),
  replaceCustomObject: (_spec, namespace, _name, body) =>
    runKubectlJson(['replace', '-f', '-', '-o', 'json'], withNamespace(options, namespace), JSON.stringify(body)),
  deleteCustomObject: (spec, namespace, name) =>
    runKubectlJson(['delete', resourceRef(spec), name, '-o', 'json'], withNamespace(options, namespace)),
  listPods: (namespace, labelSelector) => {
    const args = ['get', 'pods', '-o', 'json']
    if (labelSelector) args.push('-l', labelSelector)
    return runKubectlJson(args, withNamespace(options, namespace))
  },
  deleteJob: async (namespace, name) => {
    const result = await runKubectl(['delete', 'job', name], withNamespace(options, namespace))
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `kubectl delete job ${name} failed`
      throw new KubectlError(message, result.stderr, result.exitCode)
    }
  },
  deleteJobsBySelector: async (namespace, selector) => {
    const result = await runKubectl(['delete', 'job', '-l', selector], withNamespace(options, namespace))
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `kubectl delete job -l ${selector} failed`
      throw new KubectlError(message, result.stderr, result.exitCode)
    }
  },
  streamPodLogs: async (namespace, podName, container, follow) => {
    const args = ['logs', podName]
    if (container) args.push('-c', container)
    if (follow) args.push('-f')
    const proc = Bun.spawn(['kubectl', ...buildKubectlArgs(withNamespace(options, namespace)), ...args], {
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new KubectlError(`kubectl logs failed with exit code ${exitCode}`, undefined, exitCode)
    }
  },
})
