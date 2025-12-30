import { App } from 'cdk8s'
import { ServerChart } from './server-chart'

const image = process.env.IMAGE ?? 'registry.ide-newton.ts.net/lab/bonjour:latest'
const namespace = process.env.NAMESPACE ?? 'bonjour'
const replicas = Number.parseInt(process.env.REPLICAS ?? '2', 10)
const port = Number.parseInt(process.env.PORT ?? '3000', 10)
const cpuTarget = Number.parseInt(process.env.CPU_TARGET_PERCENT ?? '70', 10)

const app = new App()

new ServerChart(app, 'bonjour', {
  namespace,
  image,
  replicas,
  containerPort: port,
  cpuTargetUtilizationPercent: cpuTarget,
})

app.synth()
