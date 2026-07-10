import { Chart } from 'cdk8s'
import type { Construct } from 'constructs'

import { IntOrString, KubeDeployment, KubeService, Quantity } from '../../imports/k8s'

export interface AnalysisChartProps {
  readonly namespace: string
}

const appLabels = { app: 'analysis' }

export class AnalysisChart extends Chart {
  public constructor(scope: Construct, id: string, props: AnalysisChartProps) {
    super(scope, id)

    new KubeDeployment(this, 'deployment', {
      metadata: {
        name: 'analysis',
        namespace: props.namespace,
        labels: appLabels,
      },
      spec: {
        strategy: {
          type: 'RollingUpdate',
          rollingUpdate: {
            maxSurge: IntOrString.fromNumber(0),
            maxUnavailable: IntOrString.fromNumber(1),
          },
        },
        selector: {
          matchLabels: appLabels,
        },
        template: {
          metadata: {
            labels: appLabels,
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
                    port: IntOrString.fromString('http'),
                  },
                  initialDelaySeconds: 3,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: {
                    path: '/',
                    port: IntOrString.fromString('http'),
                  },
                  initialDelaySeconds: 10,
                  periodSeconds: 30,
                },
                resources: {
                  limits: {
                    cpu: Quantity.fromString('500m'),
                    memory: Quantity.fromString('256Mi'),
                  },
                  requests: {
                    cpu: Quantity.fromString('50m'),
                    memory: Quantity.fromString('64Mi'),
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
    })

    new KubeService(this, 'service', {
      metadata: {
        name: 'analysis',
        namespace: props.namespace,
      },
      spec: {
        selector: appLabels,
        ports: [
          {
            name: 'http',
            port: 80,
            targetPort: IntOrString.fromString('http'),
          },
        ],
      },
    })

    new KubeService(this, 'tailscale-service', {
      metadata: {
        name: 'analysis-tailscale',
        namespace: props.namespace,
        annotations: {
          'tailscale.com/expose': 'true',
          'tailscale.com/hostname': 'analysis',
        },
      },
      spec: {
        type: 'LoadBalancer',
        loadBalancerClass: 'tailscale',
        selector: appLabels,
        ports: [
          {
            name: 'http',
            port: 80,
            targetPort: IntOrString.fromString('http'),
          },
        ],
      },
    })
  }
}
