import { Chart } from 'cdk8s'
import type { Construct } from 'constructs'

import { IntOrString, KubeDeployment, KubeService, Quantity } from '../../imports/k8s'
import { IngressRoute, IngressRouteSpecRoutesKind, IngressRouteSpecRoutesServicesPort } from '../../imports/traefik.io'

export interface DocsChartProps {
  readonly namespace: string
}

const appLabels = { app: 'docs' }

export class DocsChart extends Chart {
  public constructor(scope: Construct, id: string, props: DocsChartProps) {
    super(scope, id)

    new KubeDeployment(this, 'deployment', {
      metadata: {
        name: 'docs',
        namespace: props.namespace,
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
                name: 'docs',
                image: 'registry.ide-newton.ts.net/lab/docs',
                resources: {
                  limits: {
                    cpu: Quantity.fromString('1'),
                    memory: Quantity.fromString('512Mi'),
                  },
                  requests: {
                    cpu: Quantity.fromString('200m'),
                    memory: Quantity.fromString('256Mi'),
                  },
                },
                ports: [{ containerPort: 3000 }],
              },
            ],
          },
        },
      },
    })

    new KubeService(this, 'service', {
      metadata: {
        name: 'docs',
        namespace: props.namespace,
      },
      spec: {
        selector: appLabels,
        ports: [
          {
            port: 80,
            targetPort: IntOrString.fromNumber(3000),
          },
        ],
      },
    })

    new IngressRoute(this, 'ingress-route', {
      metadata: {
        name: 'docs',
        namespace: props.namespace,
      },
      spec: {
        entryPoints: ['web', 'websecure'],
        routes: [
          {
            kind: IngressRouteSpecRoutesKind.RULE,
            match: 'Host(`docs.proompteng.ai`)',
            services: [
              {
                name: 'docs',
                port: IngressRouteSpecRoutesServicesPort.fromNumber(80),
              },
            ],
          },
        ],
      },
    })
  }
}
