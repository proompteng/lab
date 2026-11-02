import type { SynthesisFactCheck, SynthesisSourcePost } from '~/server/schema'

const tagRules: Array<{ tag: string; patterns: RegExp[] }> = [
  { tag: 'semis', patterns: [/\bsemi(conductor)?s?\b/i, /\bchip(s|let)?\b/i, /\bhbm\b/i, /\bpackaging\b/i] },
  { tag: 'ai-agents', patterns: [/\bagents?\b/i, /\bautonomous\b/i, /\bbrowser agents?\b/i] },
  { tag: 'devtools', patterns: [/\bdev ?tools?\b/i, /\bdeveloper\b/i, /\bide\b/i, /\bcli\b/i] },
  { tag: 'software-engineering', patterns: [/\bsoftware\b/i, /\bengineering\b/i, /\bdeploy(ment)?\b/i] },
  { tag: 'machine-learning', patterns: [/\bmachine learning\b/i, /\bml\b/i, /\bmodel(s)?\b/i, /\binference\b/i] },
  { tag: 'quant-trading', patterns: [/\bquant\b/i, /\btrading\b/i, /\bmarket(s)?\b/i] },
  { tag: 'options', patterns: [/\boptions?\b/i, /\bvol(atility)?\b/i, /\bput(s)?\b/i, /\bcall(s)?\b/i] },
  { tag: 'trading-systems', patterns: [/\bexecution\b/i, /\border book\b/i, /\blatency\b/i, /\bsystems?\b/i] },
  { tag: 'security', patterns: [/\bsecurity\b/i, /\bcve\b/i, /\bauth\b/i, /\bexploit\b/i] },
]

const normalizeTag = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^a-z0-9$+._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

export const normalizeTopicTags = (tags: readonly string[]) => {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const tag of tags) {
    const value = normalizeTag(tag)
    if (!value || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }
  return normalized
}

export const deriveTopicTagsFromText = (text: string, limit = 6) => {
  const tags: string[] = []
  for (const rule of tagRules) {
    if (rule.patterns.some((pattern) => pattern.test(text))) tags.push(rule.tag)
  }
  return normalizeTopicTags(tags).slice(0, limit)
}

export const deriveTopicTagsFromItemContent = (input: {
  title?: string | null
  synthesis?: string | null
  summary?: string | null
  whyValuable?: string | null
  observedText?: string | null
  takeaways?: readonly string[] | null
  evidence?: readonly string[] | null
  topicTags?: readonly string[] | null
  sourcePosts?: readonly Pick<SynthesisSourcePost, 'observedText' | 'authorHandle' | 'authorName'>[] | null
  factChecks?: readonly Pick<SynthesisFactCheck, 'claim' | 'explanation'>[] | null
}) => {
  const provided = normalizeTopicTags(input.topicTags ?? [])
  if (provided.length) return provided

  const text = [
    input.title,
    input.synthesis,
    input.summary,
    input.whyValuable,
    input.observedText,
    ...(input.takeaways ?? []),
    ...(input.evidence ?? []),
    ...(input.sourcePosts ?? []).flatMap((source) => [source.observedText, source.authorHandle, source.authorName]),
    ...(input.factChecks ?? []).flatMap((factCheck) => [factCheck.claim, factCheck.explanation]),
  ]
    .filter(Boolean)
    .join(' ')

  return deriveTopicTagsFromText(text)
}
