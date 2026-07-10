import type { ApplicationDefinition } from '../application'

export type KubernetesManifest = {
  readonly apiVersion: string
  readonly kind: string
  readonly metadata: {
    readonly name: string
    readonly namespace: string
    readonly [key: string]: unknown
  }
  readonly [key: string]: unknown
}

export interface ResourceIdentity {
  readonly apiVersion: string
  readonly kind: string
  readonly namespace: string
  readonly name: string
}

const dnsSubdomainPattern = /^[a-z0-9](?:[-.a-z0-9]*[a-z0-9])?$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Manifest field ${field} must be a non-empty string`)
  }
  return value
}

const assertDeploymentSelector = (manifest: KubernetesManifest) => {
  if (manifest.kind !== 'Deployment' || !isRecord(manifest.spec)) return

  const selector = manifest.spec.selector
  const template = manifest.spec.template
  if (!isRecord(selector) || !isRecord(selector.matchLabels)) {
    throw new Error(`Deployment/${manifest.metadata.name} must define spec.selector.matchLabels`)
  }
  if (!isRecord(template) || !isRecord(template.metadata) || !isRecord(template.metadata.labels)) {
    throw new Error(`Deployment/${manifest.metadata.name} must define pod template labels`)
  }

  for (const [key, value] of Object.entries(selector.matchLabels)) {
    if (template.metadata.labels[key] !== value) {
      throw new Error(`Deployment/${manifest.metadata.name} selector '${key}' does not match pod labels`)
    }
  }
}

const assertImagesAreLogical = (value: unknown, path = '') => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertImagesAreLogical(entry, `${path}[${index}]`))
    return
  }
  if (!isRecord(value)) return

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key
    if (key === 'image') {
      const image = requireString(child, childPath)
      if (image.includes('@sha256:')) {
        throw new Error(`Generated manifests must use logical images, got digest at ${childPath}`)
      }
    }
    assertImagesAreLogical(child, childPath)
  }
}

export const assertManifest = (
  definition: ApplicationDefinition,
  value: unknown,
): { readonly manifest: KubernetesManifest; readonly identity: ResourceIdentity } => {
  if (!isRecord(value)) throw new Error('Synthesized YAML document must be an object')

  const apiVersion = requireString(value.apiVersion, 'apiVersion')
  const kind = requireString(value.kind, 'kind')
  if (!isRecord(value.metadata)) throw new Error(`${kind} metadata must be an object`)
  const name = requireString(value.metadata.name, 'metadata.name')
  const namespace = requireString(value.metadata.namespace, 'metadata.namespace')

  if (!dnsSubdomainPattern.test(name)) throw new Error(`${kind} has an unsafe metadata.name: ${name}`)
  if (namespace !== definition.namespace) {
    throw new Error(`${kind}/${name} must use namespace ${definition.namespace}, got ${namespace}`)
  }
  if (kind === 'Namespace') throw new Error('Generated applications must not contain Namespace resources')
  if (kind === 'Secret') throw new Error('Generated applications must not contain plaintext Secret resources')

  const manifest = value as KubernetesManifest
  assertDeploymentSelector(manifest)
  assertImagesAreLogical(manifest)

  return {
    manifest,
    identity: { apiVersion, kind, namespace, name },
  }
}

export const kindToKebabCase = (kind: string): string =>
  kind
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()

export const resourceFilename = (identity: ResourceIdentity): string =>
  `${kindToKebabCase(identity.kind)}-${identity.name}.yaml`

export const identityKey = (identity: ResourceIdentity): string =>
  `${identity.apiVersion}/${identity.kind}/${identity.namespace}/${identity.name}`
