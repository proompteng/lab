import { ensureCli, run } from './cli'

export const updateKnativeServiceImage = async (
  service: string,
  namespace: string,
  image: string,
  extraArgs: string[] = [],
) => {
  ensureCli('kn')
  await run('kn', ['service', 'update', service, '--namespace', namespace, '--image', image, '--wait', ...extraArgs])
}

export const applyKnativeServiceImage = async (
  service: string,
  namespace: string,
  manifest: string,
  image: string,
  extraArgs: string[] = [],
) => {
  ensureCli('kn')
  await run('kn', [
    'service',
    'apply',
    service,
    '--namespace',
    namespace,
    '--filename',
    manifest,
    '--image',
    image,
    ...extraArgs,
  ])
}
