import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '../../..')
const source = resolve(root, 'proto/proompteng/jangar/v1/agentctl.proto')
const destination = resolve(root, 'services/jangar/.output/server/proto/proompteng/jangar/v1/agentctl.proto')

await mkdir(dirname(destination), { recursive: true })
await copyFile(source, destination)

console.log(`Copied agentctl proto to ${destination}`)
