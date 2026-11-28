import { expect, test } from 'bun:test'

type Resource = { kind: string; metadata: { name: string } }
type WebDeployment = Resource & {
  spec: {
    template: {
      spec: {
        containers: {
          name: string
          livenessProbe?: {
            exec?: { command: string[] }
            failureThreshold: number
            periodSeconds: number
            timeoutSeconds: number
          }
        }[]
      }
    }
  }
}

test('web liveness allows a slow batch and scheduler recovery but still restarts on sustained failure', () => {
  const render = Bun.spawnSync(['kustomize', 'build', '--enable-helm', '.'], {
    cwd: import.meta.dir,
    stderr: 'inherit',
    timeout: 45_000,
  })
  if (!render.success) throw new Error('Could not render GlitchTip; use Kustomize with Helm 3')

  const resources = Bun.YAML.parse(render.stdout.toString()) as Resource[]
  const deployment = resources.find(({ kind, metadata }) => kind === 'Deployment' && metadata.name === 'glitchtip-web')
  const probe = (deployment as WebDeployment | undefined)?.spec.template.spec.containers.find(
    ({ name }) => name === 'glitchtip',
  )?.livenessProbe
  if (!probe) throw new Error('Missing the GlitchTip web liveness probe')

  expect(probe.exec?.command).toEqual(['python', '/opt/glitchtip-health/scheduler-health.py'])
  expect(probe.timeoutSeconds).toBeLessThan(probe.periodSeconds)
  const slowBatchSeconds = 65
  const maxSchedulerBackoffSeconds = 60
  const maxLivenessWindowSeconds = 180
  // The first failure counts toward the threshold. An immediate failure can start the streak at t=0.
  expect((probe.failureThreshold - 1) * probe.periodSeconds).toBeGreaterThan(
    slowBatchSeconds + maxSchedulerBackoffSeconds,
  )
  expect(probe.failureThreshold * probe.periodSeconds + probe.timeoutSeconds).toBeLessThanOrEqual(maxLivenessWindowSeconds)
})
