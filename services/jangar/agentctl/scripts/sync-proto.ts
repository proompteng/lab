import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '../../../..')
const source = resolve(root, 'proto/proompteng/jangar/v1/agentctl.proto')
const destination = resolve(root, 'services/jangar/agentctl/proto/proompteng/jangar/v1/agentctl.proto')

await mkdir(dirname(destination), { recursive: true })
await copyFile(source, destination)

console.log(`Synced proto to ${destination}`)
