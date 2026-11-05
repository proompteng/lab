import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

type Container = {
  name: string
  restartPolicy?: string
  env?: Array<{ name: string }>
  volumeMounts?: Array<{ name: string; mountPath: string }>
  securityContext?: { privileged?: boolean }
}

const deployment = YAML.parse(readRepoFile('argocd/applications/jangar/deployment.yaml')) as {
  spec: {
    template: {
      spec: {
        initContainers: Container[]
        containers: Container[]
        volumes: Array<{ name: string; persistentVolumeClaim?: { claimName: string } }>
      }
    }
  }
}
const pod = deployment.spec.template.spec

describe('Jangar application runtime', () => {
  it('runs the app with a terminating workspace bootstrap and no Docker sidecar or socket', () => {
    expect(pod.containers.map(({ name }) => name)).toEqual(['app'])
    expect(pod.initContainers.map(({ name }) => name)).toEqual(['bootstrap-workspace'])
    for (const container of [...pod.initContainers, ...pod.containers]) {
      expect(container.restartPolicy).not.toBe('Always')
      expect(container.securityContext?.privileged).not.toBe(true)
      expect(container.env?.filter(({ name }) => name.startsWith('DOCKER_')) ?? []).toEqual([])
      expect(
        container.volumeMounts?.filter(({ mountPath }) =>
          ['/var/lib/docker', '/var/run', '/var/run/docker.sock'].includes(mountPath),
        ) ?? [],
      ).toEqual([])
    }
    for (const name of ['docker-lib', 'docker-sock']) {
      expect(pod.volumes.map((volume) => volume.name)).not.toContain(name)
    }
  })

  it('preserves the persistent workspace for bootstrap and the app', () => {
    expect(pod.volumes.find(({ name }) => name === 'workspace')?.persistentVolumeClaim?.claimName).toBe(
      'jangar-workspace',
    )
    for (const container of [
      pod.initContainers.find(({ name }) => name === 'bootstrap-workspace'),
      ...pod.containers,
    ]) {
      expect(container).toBeDefined()
      expect(container?.volumeMounts).toContainEqual({ name: 'workspace', mountPath: '/workspace' })
    }
  })

  it('omits Docker client and Buildx tooling from both runtime image definitions', () => {
    expect(readRepoFile('nix/images/jangar.nix')).not.toMatch(/pkgs\.docker-(?:client|buildx)\b/)
    expect(readRepoFile('services/jangar/Dockerfile')).not.toMatch(/DOCKER_CLI_VERSION|BUILDX_VERSION|docker-buildx/)
  })
})
