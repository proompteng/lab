import { Chart } from 'cdk8s'
import { Protocol, Service, ServiceType } from 'cdk8s-plus-31'
import type { Construct } from 'constructs'
import { z } from 'zod'

const serviceSchema = z.object({
  name: z.string(),
  type: z.nativeEnum(ServiceType),
  selector: z.object({
    app: z.string(),
  }),
  ports: z.array(
    z.object({
      port: z.number(),
      targetPort: z.number(),
      protocol: z.nativeEnum(Protocol),
    }),
  ),
})

export class KustomizationService extends Chart {
  constructor(scope: Construct, id: string, props: z.infer<typeof serviceSchema>) {
    super(scope, 'service')
    serviceSchema.parse(props)

    this.#createService(id, props)
  }

  #createService(id: string, props: z.infer<typeof serviceSchema>) {
    const service = new Service(this, `${id}-service`, {
      metadata: {
        name: props.name,
      },
      type: props.type,
      ports: props.ports,
    })
    service.selectLabel('app', props.selector.app)
  }
}
