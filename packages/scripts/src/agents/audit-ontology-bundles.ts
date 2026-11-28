#!/usr/bin/env bun
import { parseArgs } from 'node:util'

import { type AuditReport, auditOntologyBundles, findingDescriptions } from './audit-ontology-bundles-core'

const usage =
  'Usage: bun run packages/scripts/src/agents/audit-ontology-bundles.ts [--root <dir>] [--bundles <path> ...] [--format json|markdown] [--fail-on-error]'

const parseOptions = (args: string[]) => {
  const { values, tokens } = parseArgs({
    args,
    options: {
      root: { type: 'string', default: process.cwd() },
      bundles: { type: 'string', multiple: true },
      format: { type: 'string', default: 'markdown' },
      'fail-on-error': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    tokens: true,
  })
  const { root, format, help } = values
  if (!root || (format !== 'json' && format !== 'markdown')) return undefined

  const bundles: string[] = []
  let readingBundles = false
  for (const token of tokens) {
    if (token.kind === 'option') {
      readingBundles = token.name === 'bundles'
      if (readingBundles) {
        if (!token.value) return undefined
        bundles.push(token.value)
      }
    } else if (token.kind === 'positional' && readingBundles && token.value) {
      bundles.push(token.value)
    } else {
      return undefined
    }
  }
  return { root, bundles: bundles.length ? bundles : undefined, format, failOnError: values['fail-on-error'], help }
}

const markdown = ({ bundles, findings }: AuditReport) => {
  const lines = ['# Auto Ontology bundle audit', '', `## Bundles (${bundles.length})`, '']
  for (const [index, bundle] of bundles.entries()) lines.push(`${index + 1}. \`${bundle}\``)
  if (bundles.length === 0) lines.push('No bundles found.')
  lines.push('', `## Findings (${findings.length})`, '')
  if (findings.length === 0) lines.push('No findings.')
  for (const { code, locations } of findings) {
    lines.push(`- **${code}**: ${findingDescriptions[code]}`)
    for (const { bundle, path, offset } of locations) {
      const at = offset === undefined ? '' : ` (character ${offset})`
      lines.push(`  - Bundle ${bundle + 1}: \`${bundles[bundle]}\` at \`${path}\`${at}`)
    }
  }
  return lines.join('\n')
}

const main = async (args: string[]) => {
  let options: ReturnType<typeof parseOptions>
  try {
    options = parseOptions(args)
  } catch {
    // Argument parser errors can contain untrusted input.
  }
  if (!options) {
    console.error(usage)
    return 2
  }
  if (options.help) {
    console.log(usage)
    return 0
  }
  try {
    const report = await auditOntologyBundles(options.root, options.bundles)
    console.log(options.format === 'json' ? JSON.stringify(report, null, 2) : markdown(report))
    return options.failOnError && report.findings.length ? 1 : 0
  } catch {
    console.error('Could not audit ontology bundles under the selected root.')
    return 2
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
