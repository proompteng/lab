import { Chart } from 'cdk8s'
import type { Construct } from 'constructs'
import { Kustomization } from './common/kustomization'

export class RootKustomization extends Chart {
  constructor(scope: Construct, id: string, props: { overlays: string[]; name: string }) {
    super(scope, id)
    const { overlays, name } = props
    new Kustomization(this, id, {
      name,
      resources: overlays,
    })
  }
}
