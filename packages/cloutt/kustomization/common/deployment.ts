import { Size } from 'cdk8s'
import { Cpu, Deployment } from 'cdk8s-plus-31'
import { Construct } from 'constructs'
import { z } from 'zod'

const deploymentSchema = z.object({
  name: z.string(),
  replicas: z.number().min(1),
  image: z.string().startsWith('registry.ide-newton.ts.net/lab/'),
  containerPort: z.number().min(1).max(65535),
  cpuRequest: z.number().min(1),
  cpuLimit: z.number().min(1),
  memoryRequest: z.number().min(1),
  memoryLimit: z.number().min(1),
})

export class KustomizationDeployment extends Construct {
  constructor(scope: Construct, id: string, props: z.infer<typeof deploymentSchema>) {
    super(scope, id)
    deploymentSchema.parse(props)

    this.#createDeployment(id, props)
  }

  #createDeployment(id: string, props: z.infer<typeof deploymentSchema>) {
    new Deployment(this, `${id}-deployment`, {
      metadata: {
        name: props.name,
      },
      replicas: props.replicas,
      containers: [
        {
          name: props.name,
          image: props.image,
          portNumber: props.containerPort,
          resources: {
            cpu: {
              request: Cpu.millis(props.cpuRequest),
              limit: Cpu.millis(props.cpuLimit),
            },
            memory: {
              request: Size.mebibytes(props.memoryRequest),
              limit: Size.mebibytes(props.memoryLimit),
            },
          },
        },
      ],
      securityContext: {
        ensureNonRoot: true,
        user: 1000,
      },
    })
  }
}
