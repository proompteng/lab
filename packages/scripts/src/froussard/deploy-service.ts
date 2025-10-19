#!/usr/bin/env bun

import { relative, resolve } from 'node:path'
import process from 'node:process'
import { $ } from 'bun'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'

const ignoredAnnotations = new Set(['client.knative.dev/nonce', 'kubectl.kubernetes.io/last-applied-configuration'])

const defaultNamespace = 'froussard'
const defaultService = 'froussard'
const defaultManifestPath = 'argocd/applications/froussard/knative-service.yaml'

const execGit = (args: string[]): string => {
  const result = Bun.spawnSync(['git', ...args], { cwd: repoRoot })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed`)
  }
  return result.stdout.toString().trim()
}

const ensureVersions = () => {
  const version =
    process.env.FROUSSARD_VERSION?.trim() && process.env.FROUSSARD_VERSION.trim().length > 0
      ? process.env.FROUSSARD_VERSION.trim()
      : execGit(['describe', '--tags', '--always'])

  const commit =
    process.env.FROUSSARD_COMMIT?.trim() && process.env.FROUSSARD_COMMIT.trim().length > 0
      ? process.env.FROUSSARD_COMMIT.trim()
      : execGit(['rev-parse', 'HEAD'])

  if (!version) {
    throw new Error('Failed to determine FROUSSARD_VERSION')
  }
  if (!commit) {
    throw new Error('Failed to determine FROUSSARD_COMMIT')
  }

  return { version, commit }
}

const sanitizeObject = (value: Record<string, unknown> | undefined) => {
  if (!value) {
    return undefined
  }

  const entries = Object.entries(value).filter(
    ([key, entry]) =>
      !ignoredAnnotations.has(key) &&
      entry !== undefined &&
      entry !== null &&
      !(typeof entry === 'string' && entry.trim().length === 0),
  )

  if (entries.length === 0) {
    return undefined
  }

  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))
}

const sanitizeResources = (value: unknown): unknown => {
  if (value === undefined || value === null) {
    return undefined
  }

  if (Array.isArray(value)) {
    const sanitizedArray = value
      .map((entry) => sanitizeResources(entry))
      .filter((entry) => entry !== undefined) as unknown[]
    return sanitizedArray.length > 0 ? sanitizedArray : []
  }

  if (typeof value !== 'object') {
    if (typeof value === 'string' && value.trim().length === 0) {
      return undefined
    }
    return value
  }

  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const sanitized = sanitizeResources(entry)
    if (sanitized === undefined) {
      continue
    }

    if (Array.isArray(sanitized)) {
      result[key] = sanitized
      continue
    }

    if (typeof sanitized === 'object' && sanitized !== null && Object.keys(sanitized).length === 0) {
      result[key] = sanitized
      continue
    }

    result[key] = sanitized
  }

  return Object.keys(result).length > 0 ? result : {}
}

const exportKnativeManifest = async ({
  manifestPath,
  namespace,
  service,
}: {
  manifestPath: string
  namespace: string
  service: string
}) => {
  const manifestJson = await $`kubectl get ksvc ${service} --namespace ${namespace} -o json`.text()
  const parsed = JSON.parse(manifestJson)

  const container = parsed?.spec?.template?.spec?.containers?.[0]
  if (!container || typeof container !== 'object') {
    throw new Error(`Unable to resolve container spec for service ${service}`)
  }

  const env = Array.isArray(container.env)
    ? container.env
        .filter((entry: unknown): entry is { name: string; value?: string; valueFrom?: unknown } => {
          return (
            !!entry &&
            typeof entry === 'object' &&
            typeof (entry as { name?: unknown }).name === 'string' &&
            (('value' in (entry as object) && typeof (entry as { value?: unknown }).value === 'string') ||
              'valueFrom' in (entry as object))
          )
        })
        .filter((entry) => entry.name !== 'BUILT')
        .map((entry) => {
          if ('valueFrom' in entry && entry.valueFrom) {
            return { name: entry.name, valueFrom: entry.valueFrom }
          }
          return { name: entry.name, value: entry.value ?? '' }
        })
    : []

  const annotations = sanitizeObject(parsed?.metadata?.annotations) ?? {}
  const templateAnnotations = sanitizeObject(parsed?.spec?.template?.metadata?.annotations) ?? {}
  annotations['argocd.argoproj.io/tracking-id'] =
    `${namespace}:serving.knative.dev/Service:${namespace}/${parsed?.metadata?.name ?? service}`
  annotations['argocd.argoproj.io/compare-options'] = 'IgnoreExtraneous'

  const sanitizedManifest = {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name: parsed?.metadata?.name ?? service,
      namespace: parsed?.metadata?.namespace ?? namespace,
      annotations,
      labels: sanitizeObject(parsed?.metadata?.labels),
    },
    spec: {
      template: {
        metadata: {
          annotations: templateAnnotations,
          labels: sanitizeObject(parsed?.spec?.template?.metadata?.labels),
        },
        spec: {
          containerConcurrency: parsed?.spec?.template?.spec?.containerConcurrency ?? 0,
          timeoutSeconds: parsed?.spec?.template?.spec?.timeoutSeconds ?? 300,
          enableServiceLinks: parsed?.spec?.template?.spec?.enableServiceLinks ?? false,
          containers: [
            {
              name: container.name ?? 'user-container',
              image: container.image,
              env,
              readinessProbe: container.readinessProbe,
              livenessProbe: container.livenessProbe,
              resources: sanitizeResources(container.resources),
              securityContext:
                container.securityContext && Object.keys(container.securityContext).length > 0
                  ? container.securityContext
                  : undefined,
            },
          ],
        },
      },
    },
  }

  const manifestAbsolutePath = resolve(repoRoot, manifestPath)
  const YAML = await import('yaml')
  const manifestYaml = `---\n${YAML.stringify(sanitizedManifest, { lineWidth: 120 })}`
  await Bun.write(manifestAbsolutePath, manifestYaml)

  console.log(
    `Exported Knative service manifest to ${relative(repoRoot, manifestAbsolutePath)}. Please commit the updated file.`,
  )
}

export const main = async () => {
  ensureCli('kubectl')
  ensureCli('pnpm')

  const namespace = process.env.FROUSSARD_NAMESPACE?.trim() || defaultNamespace
  const service = process.env.FROUSSARD_SERVICE?.trim() || defaultService
  const manifestPath = process.env.FROUSSARD_KNATIVE_MANIFEST?.trim() || defaultManifestPath

  const { version, commit } = await ensureVersions()

  console.log(`Deploying froussard version ${version} (${commit})`)

  const args = process.argv.slice(2)
  const passThrough = args.length > 0 ? ['--', ...args] : []

  await run('pnpm', ['--filter', 'froussard', 'run', 'deploy', ...passThrough], {
    env: {
      ...process.env,
      FROUSSARD_VERSION: version,
      FROUSSARD_COMMIT: commit,
    },
    cwd: repoRoot,
  })

  await exportKnativeManifest({ manifestPath, namespace, service })
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy froussard', error))
}

export const __private = {
  ensureVersions,
  exportKnativeManifest,
}
