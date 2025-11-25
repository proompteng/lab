import config from '../registry.config'
import { $ } from 'bun'
import { mkdir } from 'node:fs/promises'

async function generate() {
  await mkdir('.gen', { recursive: true })

  for (const reg of config) {
    console.log(`Generating client for ${reg.id}...`)
    const outPath = `.gen/${reg.id}.ts`
    try {
      // Use bunx to run openapi-typescript
      // We catch error to continue with other registries if one fails
      await $`bunx openapi-typescript ${reg.openapiUrl} -o ${outPath}`
    } catch (e) {
      console.error(`Failed to generate client for ${reg.id}:`, e)
    }
  }
}

generate()
