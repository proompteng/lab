import { describe, expect, it } from 'bun:test'
import { Testing } from 'cdk8s'

import { DocsChart } from './chart'

type Manifest = {
  readonly apiVersion: string
  readonly kind: string
  readonly metadata: {
    readonly name: string
    readonly namespace: string
    readonly [key: string]: unknown
  }
  readonly [key: string]: unknown
}

const synthesize = (): Record<string, Manifest> => {
  const app = Testing.app()
  const chart = new DocsChart(app, 'docs', { namespace: 'docs' })
  const manifests = Testing.synth(chart) as Manifest[]

  return Object.fromEntries(manifests.map((manifest) => [`${manifest.kind}/${manifest.metadata.name}`, manifest]))
}

describe('DocsChart', () => {
  it('synthesizes the production docs resource contract', () => {
    expect(synthesize()).toEqual({
      'Deployment/docs': {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'docs',
          namespace: 'docs',
        },
        spec: {
          strategy: {
            type: 'RollingUpdate',
            rollingUpdate: {
              maxSurge: 0,
              maxUnavailable: 1,
            },
          },
          selector: {
            matchLabels: { app: 'docs' },
          },
          template: {
            metadata: {
              labels: { app: 'docs' },
            },
            spec: {
              nodeSelector: {
                'kubernetes.io/arch': 'arm64',
              },
              containers: [
                {
                  name: 'docs',
                  image: 'registry.ide-newton.ts.net/lab/docs',
                  resources: {
                    limits: {
                      cpu: '1',
                      memory: '512Mi',
                    },
                    requests: {
                      cpu: '200m',
                      memory: '256Mi',
                    },
                  },
                  ports: [{ containerPort: 3000 }],
                },
              ],
            },
          },
        },
      },
      'IngressRoute/docs': {
        apiVersion: 'traefik.io/v1alpha1',
        kind: 'IngressRoute',
        metadata: {
          name: 'docs',
          namespace: 'docs',
        },
        spec: {
          entryPoints: ['web', 'websecure'],
          routes: [
            {
              kind: 'Rule',
              match: 'Host(`docs.proompteng.ai`)',
              services: [
                {
                  name: 'docs',
                  port: 80,
                },
              ],
            },
          ],
        },
      },
      'Service/docs': {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: 'docs',
          namespace: 'docs',
        },
        spec: {
          selector: { app: 'docs' },
          ports: [
            {
              port: 80,
              targetPort: 3000,
            },
          ],
        },
      },
    })
  })
})
