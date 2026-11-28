const credentialPrefix = /\b(?:auto_ontology_|sk-|AKIA|gh[pousr]_|github_pat_)/u
const credentialInPattern = new RegExp(credentialPrefix.source + '[\\w-]', 'u')
const credentialPatterns = [
  /\b(?:xox[baprs]-[\w-]{12,}|AIza[\w-]{35}|ASIA[A-Z0-9]{16}|nvapi-[\w-]{12,})\b/,
  /\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+\b/,
  /\bbearer\s/i,
  /\bauthorization["']?\s*[:=]\s*["']?(?:basic|bearer)\s+\S+/i,
  /(?:^|[^a-z0-9])(?:api[-_ ]?(?:key|token)|(?:access|refresh)[-_ ]?token|client[-_ ]?secret|password|passwd|secret[-_ ]?access[-_ ]?key)["']?\s*[:=]\s*["']?[^\s"',;]+/i,
  /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@:]*:[^\s/@]+@/i,
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb|rediss?|mssql)(?:\+[a-z0-9_.-]+)?:\/\//i,
]
const personalData = [
  /\b[\w.%+-]{1,64}@[\w.-]{1,253}\.[a-z]{2,63}\b/i,
  /\b\d{3}-(?:\d{2}-\d{4}|\d{3}-\d{4})\b/u,
  /\(\d{3}\)\s*\d{3}-\d{4}\b/u,
]
const rawPrompts = [
  /\b(?:raw|system|developer|user)\s+prompt\s*:/i,
  /(?:^|\n)\s*(?:--\s*)?(?:prompt|system|developer|user|assistant|tool)\s*:/i,
  /<\|(?:im_start|im_end|start_header_id|end_header_id)\|>|\[\/?INST\]/i,
  /["']role["']\s*:\s*["'](?:system|developer|user|assistant|tool)["']/i,
]

export const containsCredentials = (text: string, isSchemaPattern = false): boolean =>
  (isSchemaPattern ? credentialInPattern : credentialPrefix).test(text) ||
  (isSchemaPattern ? /-----BEGIN [A-Z0-9 ]+-----/iu : /-----BEGIN/iu).test(text) ||
  credentialPatterns.some((pattern) => pattern.test(text))

export const disclosureProblem = (text: string, isSchemaPattern = false): string | undefined => {
  if (containsCredentials(text, isSchemaPattern) || personalData.some((pattern) => pattern.test(text))) {
    return 'Possible credential or personal data; remove it before committing'
  }
  if (!isSchemaPattern && rawPrompts.some((pattern) => pattern.test(text))) {
    return 'Possible raw prompt or transcript; summarize the evidence instead'
  }
}

export const assertSafeOntologyText = (text: string, isSchemaPattern = false) => {
  const problem = disclosureProblem(text, isSchemaPattern)
  if (problem) throw new Error(problem)
}

export const findOntologyDisclosure = (value: unknown, schema = false): string | undefined => {
  const pending: { value: unknown; pattern?: boolean }[] = [{ value }]
  for (const item of pending) {
    if (typeof item.value === 'string') {
      const problem = disclosureProblem(item.value, item.pattern)
      if (problem) return problem
    } else if (Array.isArray(item.value)) {
      for (const child of item.value) pending.push({ value: child })
    } else if (item.value !== null && typeof item.value === 'object') {
      for (const [key, child] of Object.entries(item.value)) {
        pending.push({ value: key }, { value: child, pattern: schema && key === 'pattern' })
      }
    }
  }
}
