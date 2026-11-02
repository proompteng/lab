import type { SynthesisItem } from '~/server/schema'

export type CompanySymbol = (typeof knownCompanySymbols)[number]

export const knownCompanySymbols = [
  'AAPL',
  'AMD',
  'AMZN',
  'ARM',
  'ASML',
  'AVGO',
  'COIN',
  'CRM',
  'GOOG',
  'GOOGL',
  'IBM',
  'INTC',
  'JPM',
  'META',
  'MSFT',
  'MU',
  'NFLX',
  'NOW',
  'NVDA',
  'ORCL',
  'PLTR',
  'QCOM',
  'SMCI',
  'TSLA',
  'TSM',
] as const

const knownCompanySymbolSet = new Set<string>(knownCompanySymbols)
const symbolPattern = /(^|[^A-Za-z0-9])(?<cashtag>\$)?(?<symbol>[A-Z][A-Z0-9.-]{0,9})(?=$|[^A-Za-z0-9])/g
const publicSymbolPattern = /^[A-Z][A-Z0-9.-]{0,9}$/

export type TextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'symbol'; text: string; symbol: string; href: string }

export const normalizeCompanySymbol = (value: string) => {
  const symbol = value.trim().replace(/^\$+/, '').replace(/\s+/g, '').toUpperCase()
  return publicSymbolPattern.test(symbol) ? symbol : null
}

export const isKnownCompanySymbol = (value: string) => {
  const symbol = normalizeCompanySymbol(value)
  return symbol ? knownCompanySymbolSet.has(symbol) : false
}

export const companyPath = (symbol: string) => `/companies/${symbol.toUpperCase()}`

export const extractCompanySymbols = (text: string) => {
  const symbols: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(symbolPattern)) {
    const symbol = normalizeCompanySymbol(match.groups?.symbol ?? '')
    const isCashtag = Boolean(match.groups?.cashtag)
    if (!symbol || seen.has(symbol)) continue
    if (!isCashtag && !knownCompanySymbolSet.has(symbol)) continue
    seen.add(symbol)
    symbols.push(symbol)
  }
  return symbols
}

export const segmentCompanySymbols = (text: string): TextSegment[] => {
  const segments: TextSegment[] = []
  let lastIndex = 0
  for (const match of text.matchAll(symbolPattern)) {
    const prefix = match[1] ?? ''
    const cashtag = match.groups?.cashtag ?? ''
    const token = match.groups?.symbol ?? ''
    const symbol = normalizeCompanySymbol(token)
    const tokenStart = (match.index ?? 0) + prefix.length
    const tokenEnd = tokenStart + cashtag.length + token.length
    if (!symbol) continue
    if (!cashtag && !knownCompanySymbolSet.has(symbol)) continue
    if (tokenStart > lastIndex) segments.push({ kind: 'text', text: text.slice(lastIndex, tokenStart) })
    segments.push({ kind: 'symbol', text: text.slice(tokenStart, tokenEnd), symbol, href: companyPath(symbol) })
    lastIndex = tokenEnd
  }
  if (lastIndex < text.length) segments.push({ kind: 'text', text: text.slice(lastIndex) })
  return segments.length ? segments : [{ kind: 'text', text }]
}

export const normalizeCompanySymbols = (values: readonly string[] | null | undefined) => {
  const symbols: string[] = []
  const seen = new Set<string>()
  for (const value of values ?? []) {
    const symbol = normalizeCompanySymbol(value)
    if (!symbol || seen.has(symbol)) continue
    seen.add(symbol)
    symbols.push(symbol)
  }
  return symbols
}

export const symbolsFromSynthesisItem = (item: SynthesisItem) => {
  const text = [
    item.title,
    item.synthesis,
    item.summary,
    item.whyValuable,
    item.observedText,
    ...item.takeaways,
    ...item.evidence,
    ...item.topicTags,
    ...item.sourcePosts.flatMap((source) => [source.observedText, source.authorHandle, source.authorName]),
    ...item.factChecks.flatMap((factCheck) => [factCheck.claim, factCheck.explanation]),
  ]
    .filter(Boolean)
    .join(' ')
  return normalizeCompanySymbols([...(item.companySymbols ?? []), ...extractCompanySymbols(text)])
}
