import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '../../../..')
const source = resolve(root, 'proto/proompteng/jangar/v1/agentctl.proto')
const destination = resolve(root, 'services/jangar/agentctl/proto/proompteng/jangar/v1/agentctl.proto')
const embeddedOutput = resolve(root, 'services/jangar/agentctl/src/embedded-proto.ts')

await mkdir(dirname(destination), { recursive: true })
await copyFile(source, destination)

const protoContents = await readFile(source, 'utf8')
const escaped = protoContents.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')
const embedded = `export const EMBEDDED_AGENTCTL_PROTO =\n  '${escaped}'\n`
await writeFile(embeddedOutput, embedded, 'utf8')

console.log(`Synced proto to ${destination}`)
console.log(`Updated embedded proto at ${embeddedOutput}`)
