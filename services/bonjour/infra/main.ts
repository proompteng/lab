import { App } from 'cdk8s'
import { ServerChart } from './server-chart'

const image = process.env.IMAGE ?? process.env.ARGOCD_ENV_IMAGE ?? 'registry.ide-newton.ts.net/lab/bonjour:latest'
const namespace = process.env.NAMESPACE ?? process.env.ARGOCD_ENV_NAMESPACE ?? 'bonjour'
const replicas = Number.parseInt(process.env.REPLICAS ?? process.env.ARGOCD_ENV_REPLICAS ?? '2', 10)
const port = Number.parseInt(process.env.PORT ?? process.env.ARGOCD_ENV_PORT ?? '3000', 10)
const cpuTarget = Number.parseInt(
  process.env.CPU_TARGET_PERCENT ?? process.env.ARGOCD_ENV_CPU_TARGET_PERCENT ?? '70',
  10,
)

const app = new App()

new ServerChart(app, 'bonjour', {
  namespace,
  image,
  replicas,
  containerPort: port,
  cpuTargetUtilizationPercent: cpuTarget,
})

app.synth()
