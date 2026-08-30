import { defineRegistries } from './src/lib/registries'

export default defineRegistries([
  {
    id: 'ghcr',
    displayName: 'GitHub Container Registry',
    baseUrl: 'https://ghcr.io',
    openapiUrl: 'https://ghcr.io/api/v3/openapi.json',
    auth: { type: 'bearer', tokenEnv: 'REESTR_REGISTRY_GHCR_TOKEN' },
    capabilities: {
      supportsReadme: true,
      supportsMetrics: true,
      supportsSbom: false,
    },
    tls: {
      allowInsecure: false,
      allowHttp: false,
    },
  },
])
