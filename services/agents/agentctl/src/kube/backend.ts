import { spawn } from 'node:child_process'

import * as Schema from 'effect/Schema'
import {
  buildKubectlArgs,
  KubectlError,
  type KubectlOptions,
  runKubectl,
  runKubectlJson,
  runKubectlOptionalJson,
} from './kubectl'
import * as resources from './resources'

export type KubeResourceSpec = {
  kind: string
  group: string
  version: string
  plural: string
}

export type PodLogOptions = {
  container?: string
  follow?: boolean
  tail?: number
  since?: string
  timestamps?: boolean
  previous?: boolean
}

export const podLogArgs = (podName: string, options: PodLogOptions) => {
  const args = ['logs', `pod/${podName}`]
  if (options.container) args.push('-c', options.container)
  if (options.follow) args.push('-f')
  if (options.tail !== undefined) args.push(`--tail=${options.tail}`)
  if (options.since !== undefined) args.push(`--since=${options.since}`)
  if (options.timestamps) args.push('--timestamps')
  if (options.previous) args.push('--previous')
  return args
}

const resourceRef = (spec: KubeResourceSpec) => `${spec.plural}.${spec.group}`

export const decodeKube = <T>(schema: Schema.Decoder<T>, value: unknown, resource: string): T => {
  const result = Schema.decodeUnknownResult(schema)(value)
  if (result._tag === 'Success') return result.success
  // Decoder errors can contain the original object, including ConfigMap data or deployment env.
  throw new KubectlError(`Invalid Kubernetes response for ${resource}`)
}

export const createKubectlBackend = (options: KubectlOptions) => {
  const scoped = (namespace?: string, signal?: AbortSignal): KubectlOptions => ({
    kubeconfig: options.kubeconfig,
    context: options.context,
    namespace,
    signal,
  })
  const list = async <T>(
    schema: Schema.Decoder<T>,
    kind: string,
    opts: KubectlOptions,
    filters: string[] = [],
  ): Promise<readonly T[]> => {
    const body = await runKubectlJson<unknown>(['get', kind, '-o', 'json', ...filters], opts)
    return decodeKube(Schema.Struct({ items: Schema.Array(schema) }), body, kind).items
  }
  const optionalGet = async <T>(schema: Schema.Decoder<T>, kind: string, name: string, opts: KubectlOptions) => {
    const body = await runKubectlOptionalJson(['get', `${kind}/${name}`, '-o', 'json'], opts)
    return body === null ? null : decodeKube(schema, body, `${kind}/${name}`)
  }
  const selector = (labelSelector?: string) => (labelSelector ? ['-l', labelSelector] : [])

  return {
    readNamespace: (name: string) => runKubectlJson(['get', `namespace/${name}`, '-o', 'json'], scoped()),
    listDeployments: (namespace: string, labelSelector?: string) =>
      list(resources.deployment, 'deployment', scoped(namespace), selector(labelSelector)),
    listCrds: () => list(resources.crd, 'crd', scoped()),
    listCustomObjects: (spec: KubeResourceSpec, namespace: string, labelSelector?: string) =>
      runKubectlJson<Record<string, unknown>>(
        ['get', resourceRef(spec), '-o', 'json', ...selector(labelSelector)],
        scoped(namespace),
      ),
    getCustomObject: (spec: KubeResourceSpec, namespace: string, name: string, signal?: AbortSignal) =>
      runKubectlJson<Record<string, unknown>>(
        ['get', `${resourceRef(spec)}/${name}`, '-o', 'json'],
        scoped(namespace, signal),
      ),
    createCustomObject: (
      _spec: KubeResourceSpec,
      namespace: string,
      body: Record<string, unknown>,
      options?: { dryRun?: boolean; signal?: AbortSignal },
    ) =>
      runKubectlJson<Record<string, unknown>>(
        ['create', '-f', '-', '-o', 'json', ...(options?.dryRun ? ['--dry-run=server'] : [])],
        scoped(namespace, options?.signal),
        JSON.stringify(body),
      ),
    replaceCustomObject: (_spec: KubeResourceSpec, namespace: string, _name: string, body: Record<string, unknown>) =>
      runKubectlJson<Record<string, unknown>>(
        ['replace', '-f', '-', '-o', 'json'],
        scoped(namespace),
        JSON.stringify(body),
      ),
    deleteCustomObject: (spec: KubeResourceSpec, namespace: string, name: string) =>
      runKubectlJson<Record<string, unknown>>(
        ['delete', `${resourceRef(spec)}/${name}`, '-o', 'json'],
        scoped(namespace),
      ),
    listPods: (namespace: string, labelSelector?: string, signal?: AbortSignal) =>
      list(resources.pod, 'pods', scoped(namespace, signal), selector(labelSelector)),
    listJobs: (namespace: string, labelSelector?: string, signal?: AbortSignal) =>
      list(resources.job, 'jobs.batch', scoped(namespace, signal), selector(labelSelector)),
    getConfigMap: (namespace: string, name: string, signal?: AbortSignal) =>
      optionalGet(resources.configMap, 'configmap', name, scoped(namespace, signal)),
    listNodes: () => list(resources.node, 'nodes', scoped()),
    listLeases: (namespace: string) => list(resources.lease, 'leases.coordination.k8s.io', scoped(namespace)),
    listEvents: (namespace: string, fieldSelector: string) =>
      list(resources.event, 'events', scoped(namespace), ['--field-selector', fieldSelector]),
    getCnpgCluster: async (namespace: string, name: string) => {
      try {
        return await optionalGet(resources.cnpgCluster, 'clusters.postgresql.cnpg.io', name, scoped(namespace))
      } catch (error) {
        if (error instanceof KubectlError && error.stderr?.includes("the server doesn't have a resource type")) {
          return null
        }
        throw error
      }
    },
    deleteJobs: async (namespace: string, names: readonly string[]) => {
      if (names.length === 0) return
      const result = await runKubectl(
        ['delete', '--ignore-not-found', '--wait=false', ...names.map((name) => `job/${name}`)],
        scoped(namespace),
      )
      if (result.exitCode !== 0) {
        throw new KubectlError(result.stderr.trim() || 'kubectl delete jobs failed', result.stderr, result.exitCode)
      }
    },
    readPodLogs: async (namespace: string, podName: string, container: string, signal?: AbortSignal) => {
      const result = await runKubectl(podLogArgs(podName, { container }), scoped(namespace, signal))
      if (result.exitCode !== 0) {
        throw new KubectlError(result.stderr.trim() || 'kubectl logs failed', result.stderr, result.exitCode)
      }
      return result.stdout
    },
    streamPodLogs: async (namespace: string, podName: string, logOptions: PodLogOptions, signal?: AbortSignal) => {
      const args = podLogArgs(podName, logOptions)
      const exitCode = await new Promise<number>((resolve, reject) => {
        const proc = spawn('kubectl', [...buildKubectlArgs(scoped(namespace)), ...args], { stdio: 'inherit', signal })
        proc.once('error', reject)
        proc.once('close', (code) => resolve(code ?? 1))
      })
      if (exitCode !== 0) throw new KubectlError(`kubectl logs failed with exit code ${exitCode}`, undefined, exitCode)
    },
  }
}

export type KubeBackend = ReturnType<typeof createKubectlBackend>
