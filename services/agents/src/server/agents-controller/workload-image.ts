import { asRecord, asString, readNested } from '../primitives'

export type WorkloadImageSource = 'agentrun' | 'provider' | 'controller-default'

export type ResolvedWorkloadImage = {
  image: string | null
  source: WorkloadImageSource | null
}

export const resolveWorkloadImage = ({
  workload,
  provider,
  defaultRunnerImage,
}: {
  workload?: Record<string, unknown> | null
  provider?: Record<string, unknown> | null
  defaultRunnerImage?: string | null
}): ResolvedWorkloadImage => {
  const runImage = asString(workload?.image)
  if (runImage) return { image: runImage, source: 'agentrun' }

  const providerWorkload = asRecord(readNested(provider, ['spec', 'workload']))
  const providerImage = asString(providerWorkload?.image)
  if (providerImage) return { image: providerImage, source: 'provider' }

  if (defaultRunnerImage) return { image: defaultRunnerImage, source: 'controller-default' }
  return { image: null, source: null }
}
