import { describe, expect, it } from 'bun:test'
import { Chart } from 'cdk8s'

import type { ApplicationDefinition } from '../application'
import { assertManifest, kindToKebabCase, resourceFilename } from './manifest-assertions'

const application: ApplicationDefinition = {
  name: 'docs',
  namespace: 'docs',
  outputDir: 'argocd/applications/docs/generated',
  create: (scope) => new Chart(scope, 'docs'),
}

const deployment = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'docs', namespace: 'docs' },
  spec: {
    selector: { matchLabels: { app: 'docs' } },
    template: {
      metadata: { labels: { app: 'docs' } },
      spec: { containers: [{ name: 'docs', image: 'registry.example/docs' }] },
    },
  },
}

describe('manifest assertions', () => {
  it('derives stable per-resource filenames', () => {
    expect(kindToKebabCase('IngressRoute')).toBe('ingress-route')
    expect(resourceFilename(assertManifest(application, deployment).identity)).toBe('deployment-docs.yaml')
  })

  it('rejects namespaces outside the application contract', () => {
    expect(() =>
      assertManifest(application, {
        ...deployment,
        metadata: { name: 'docs', namespace: 'default' },
      }),
    ).toThrow('must use namespace docs')
  })

  it('rejects plaintext Secrets', () => {
    expect(() =>
      assertManifest(application, {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'credentials', namespace: 'docs' },
      }),
    ).toThrow('plaintext Secret')
  })

  it('rejects promoted image digests in generated resources', () => {
    const digested = structuredClone(deployment)
    digested.spec.template.spec.containers[0].image = `registry.example/docs@sha256:${'a'.repeat(64)}`

    expect(() => assertManifest(application, digested)).toThrow('must use logical images')
  })

  it('rejects Deployment selectors that do not match pod labels', () => {
    const mismatched = structuredClone(deployment)
    mismatched.spec.template.metadata.labels.app = 'other'

    expect(() => assertManifest(application, mismatched)).toThrow('does not match pod labels')
  })
})
