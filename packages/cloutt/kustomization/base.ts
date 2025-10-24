import { Chart } from 'cdk8s'
import { Protocol, ServiceType } from 'cdk8s-plus-31'
import type { Construct } from 'constructs'
import { z } from 'zod'
import { KustomizationDeployment } from './common/deployment'
import { Kustomization } from './common/kustomization'
import { KustomizationService } from './common/service'

const chartSchema = z.object({
  name: z.string(),
  replicas: z.number().min(1),
  image: z.string().startsWith('registry.ide-newton.ts.net/lab/'),
  containerPort: z.number().min(1).max(65535),
  cpuRequest: z.number().min(1),
  cpuLimit: z.number().min(1),
  memoryRequest: z.number().min(1),
  memoryLimit: z.number().min(1),
})

export class KustomizationBase extends Chart {
  constructor(scope: Construct, id: string, props: z.infer<typeof chartSchema>) {
    super(scope, id)
    chartSchema.parse(props)
    const { name, replicas, image, containerPort, cpuRequest, cpuLimit, memoryRequest, memoryLimit } = props
    new Kustomization(this, `${id}-kustomization`, {
      name,
      resources: ['deployment.yaml', 'service.yaml'],
      commonLabels: {
        app: name,
        'app.kubernetes.io/name': name,
        'app.kubernetes.io/part-of': name,
      },
    })

    console.log('Created kustomization manifest for base')

    new KustomizationDeployment(this, `${id}-deployment`, {
      name,
      replicas,
      image,
      containerPort,
      cpuRequest,
      cpuLimit,
      memoryRequest,
      memoryLimit,
    })

    console.log('Created deployment manifest')

    new KustomizationService(this, `${id}-service`, {
      name,
      type: ServiceType.CLUSTER_IP,
      selector: {
        app: name,
      },
      ports: [
        {
          port: 80,
          targetPort: containerPort,
          protocol: Protocol.TCP,
        },
      ],
    })
    console.log('Created service manifest')
  }
}
