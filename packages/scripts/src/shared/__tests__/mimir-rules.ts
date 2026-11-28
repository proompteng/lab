import { readFileSync } from 'node:fs'
import YAML from 'yaml'

export const observabilityDirectory = new URL('../../../../../argocd/applications/observability/', import.meta.url)

const manifest = YAML.parseDocument(readFileSync(new URL('graf-mimir-rules.yaml', observabilityDirectory), 'utf8'))
const source = manifest.getIn(['data', 'graf-rules.yaml'])
if (typeof source !== 'string') throw new Error('Mimir rules are missing')
export const deployedMimirRules = source

type RuleGroup = {
  name: string
  rules: { alert?: string; record?: string; expr: string }[]
}

const { groups } = YAML.parse(deployedMimirRules) as { groups?: RuleGroup[] }
if (!Array.isArray(groups)) throw new Error('Mimir rule groups are missing')

export const mimirRuleGroup = (name: string) => {
  const group = groups.find((group) => group.name === name)
  if (!group) throw new Error(`Mimir rule group is missing: ${name}`)
  return group
}
