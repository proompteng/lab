import { describe, expect, it } from 'bun:test'
import { Testing } from 'cdk8s'

import { AnalysisChart } from './chart'

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
  const chart = new AnalysisChart(app, 'analysis', { namespace: 'analysis' })
  const manifests = Testing.synth(chart) as Manifest[]

  return Object.fromEntries(manifests.map((manifest) => [`${manifest.kind}/${manifest.metadata.name}`, manifest]))
}

describe('AnalysisChart', () => {
  it('synthesizes the production analysis resource contract', () => {
    expect(synthesize()).toEqual({
      'Deployment/analysis': {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'analysis',
          namespace: 'analysis',
          labels: { app: 'analysis' },
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
            matchLabels: { app: 'analysis' },
          },
          template: {
            metadata: {
              labels: { app: 'analysis' },
            },
            spec: {
              nodeSelector: {
                'kubernetes.io/arch': 'arm64',
              },
              containers: [
                {
                  name: 'analysis',
                  image: 'registry.ide-newton.ts.net/lab/analysis',
                  imagePullPolicy: 'IfNotPresent',
                  ports: [
                    {
                      name: 'http',
                      containerPort: 8080,
                    },
                  ],
                  readinessProbe: {
                    httpGet: {
                      path: '/',
                      port: 'http',
                    },
                    initialDelaySeconds: 3,
                    periodSeconds: 10,
                  },
                  livenessProbe: {
                    httpGet: {
                      path: '/',
                      port: 'http',
                    },
                    initialDelaySeconds: 10,
                    periodSeconds: 30,
                  },
                  resources: {
                    limits: {
                      cpu: '500m',
                      memory: '256Mi',
                    },
                    requests: {
                      cpu: '50m',
                      memory: '64Mi',
                    },
                  },
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    capabilities: {
                      drop: ['ALL'],
                    },
                  },
                },
              ],
            },
          },
        },
      },
      'Service/analysis': {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: 'analysis',
          namespace: 'analysis',
        },
        spec: {
          selector: { app: 'analysis' },
          ports: [
            {
              name: 'http',
              port: 80,
              targetPort: 'http',
            },
          ],
        },
      },
      'Service/analysis-tailscale': {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: 'analysis-tailscale',
          namespace: 'analysis',
          annotations: {
            'tailscale.com/expose': 'true',
            'tailscale.com/hostname': 'analysis',
          },
        },
        spec: {
          type: 'LoadBalancer',
          loadBalancerClass: 'tailscale',
          selector: { app: 'analysis' },
          ports: [
            {
              name: 'http',
              port: 80,
              targetPort: 'http',
            },
          ],
        },
      },
    })
  })
})
