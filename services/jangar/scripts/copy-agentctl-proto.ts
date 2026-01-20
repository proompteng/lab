import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '../../../..')
const sourceCandidates = [
  resolve(root, 'proto/proompteng/jangar/v1/agentctl.proto'),
  resolve(root, 'services/jangar/agentctl/proto/proompteng/jangar/v1/agentctl.proto'),
]
const source = sourceCandidates.find((candidate) => existsSync(candidate))
if (!source) {
  throw new Error(`agentctl proto not found in ${sourceCandidates.join(', ')}`)
}
const destination = resolve(root, 'services/jangar/.output/server/proto/proompteng/jangar/v1/agentctl.proto')

await mkdir(dirname(destination), { recursive: true })
await copyFile(source, destination)

console.log(`Copied agentctl proto to ${destination}`)
