import { resolveArtifactUploadConfig } from '../artifact-storage'
import type { KubernetesClient } from './kube-types'
import { asRecord, asString } from './primitives'

export const hasRunArtifactStorage = (secrets: unknown) =>
  Array.isArray(secrets) && secrets.includes('agents-artifacts')

export const readRunArtifactStorage = async (
  kube: Pick<KubernetesClient, 'get'>,
  namespace: string,
  secrets: unknown,
  env: NodeJS.ProcessEnv,
) => {
  if (!hasRunArtifactStorage(secrets)) throw new Error('run did not authorize artifact storage')
  const secret = await kube.get('secret', 'agents-artifacts', namespace)
  const data = asRecord(secret?.data) ?? {}
  const access = asString(data.AWS_ACCESS_KEY_ID)
  const secretKey = asString(data.AWS_SECRET_ACCESS_KEY)
  if (!access || !secretKey) throw new Error('artifact storage credentials are unavailable')
  const config = resolveArtifactUploadConfig({
    AGENTS_ARTIFACTS_ENDPOINT: env.AGENTS_ARTIFACTS_ENDPOINT,
    AGENTS_ARTIFACTS_BUCKET: env.AGENTS_ARTIFACTS_BUCKET,
    AGENTS_ARTIFACTS_REGION: env.AGENTS_ARTIFACTS_REGION,
    AGENTS_ARTIFACTS_ACCESS_KEY_ID: Buffer.from(access, 'base64').toString('utf8'),
    AGENTS_ARTIFACTS_SECRET_ACCESS_KEY: Buffer.from(secretKey, 'base64').toString('utf8'),
  })
  if (!config) throw new Error('artifact storage is not configured')
  return config
}
