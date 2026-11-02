import { parse } from 'yaml'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const podSpec = (deployment: string): Record<string, unknown> => {
  const manifest: unknown = parse(deployment)
  const spec = record(manifest) && record(manifest.spec) ? manifest.spec : undefined
  const template = spec !== undefined && record(spec.template) ? spec.template : undefined
  const candidate = template !== undefined && record(template.spec) ? template.spec : undefined
  if (candidate === undefined) throw new Error('Bayn deployment must contain a pod spec')
  return candidate
}

const baynContainer = (deployment: string): Record<string, unknown> => {
  const containers = podSpec(deployment).containers
  const matches = Array.isArray(containers)
    ? containers.filter((container) => record(container) && container.name === 'bayn')
    : []
  if (matches.length !== 1 || !record(matches[0])) {
    throw new Error('Bayn deployment must contain exactly one bayn container')
  }
  return matches[0]
}

export const validateNativeBaynDeployment = (deployment: string): void => {
  const spec = podSpec(deployment)
  if (spec.enableServiceLinks !== false) {
    throw new Error('Bayn deployment must disable Kubernetes service-link environment injection')
  }

  const container = baynContainer(deployment)
  const ports = Array.isArray(container.ports) ? container.ports : []
  if (ports.some((port) => record(port) && (port.name === 'lifecycle-cmd' || port.containerPort === 8081))) {
    throw new Error('Bayn deployment must not expose the retired lifecycle command port')
  }

  const environment = Array.isArray(container.env) ? container.env : []
  if (
    environment.some(
      (entry) => record(entry) && typeof entry.name === 'string' && entry.name.startsWith('BAYN_LIFECYCLE_'),
    )
  ) {
    throw new Error('Bayn deployment must not retain retired lifecycle environment inputs')
  }

  const mounts = Array.isArray(container.volumeMounts) ? container.volumeMounts : []
  if (
    mounts.some(
      (mount) =>
        record(mount) &&
        (mount.name === 'bayn-lifecycle-reviewer' || mount.mountPath === '/var/run/secrets/bayn-lifecycle-reviewer'),
    )
  ) {
    throw new Error('Bayn deployment must not mount the retired lifecycle reviewer identity')
  }

  const volumes = Array.isArray(spec.volumes) ? spec.volumes : []
  if (volumes.some((volume) => record(volume) && volume.name === 'bayn-lifecycle-reviewer')) {
    throw new Error('Bayn deployment must not project the retired lifecycle reviewer identity')
  }
}
