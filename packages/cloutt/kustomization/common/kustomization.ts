import { ApiObject, Chart } from 'cdk8s'
import type { Construct } from 'constructs'
import { z } from 'zod'

const kustomizationSchema = z.object({
  name: z.string(),
  resources: z.array(z.string()),
  namespace: z.string().optional(),
  commonLabels: z.record(z.string(), z.string()).optional(),
})

export class Kustomization extends Chart {
  constructor(scope: Construct, id: string, props: z.infer<typeof kustomizationSchema>) {
    super(scope, id)

    kustomizationSchema.parse(props)
    this.#createKustomization(id, props)
  }

  #createKustomization(id: string, props: z.infer<typeof kustomizationSchema>) {
    const { resources, namespace, commonLabels, name } = props
    new ApiObject(this, `${id}-kustomization`, {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      metadata: {
        name,
      },
      resources,
      ...(namespace && { namespace }),
      ...(commonLabels && { commonLabels }),
    })
  }
}
