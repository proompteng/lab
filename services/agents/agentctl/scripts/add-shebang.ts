import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const target = process.argv[2]
if (!target) {
  console.error('Usage: add-shebang <file>')
  process.exit(1)
}

const filePath = resolve(target)
const contents = readFileSync(filePath, 'utf8')
const shebang = '#!/usr/bin/env node\n'

if (contents.startsWith(shebang)) {
  process.exit(0)
}

const withoutExisting = contents.replace(/^#!.*\n/, '')
writeFileSync(filePath, `${shebang}${withoutExisting}`, 'utf8')
