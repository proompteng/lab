/**
 * PR body validator — rejects rendered pull-request bodies that still contain
 * template scaffolding (HTML comments, placeholder tokens, unchecked
 * checkboxes, etc.).  Pure, synchronous, unit-testable.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect a rendered PR body and return a structured error when the body
 * contains unresolved template scaffolding.
 *
 * Returns `null` when the body is clean.
 */
export const validatePullRequestBody = (body: string): ValidationError | null => {
  const issues: string[] = []

  // 1. HTML comments (e.g. `<!-- 3-5 concise bullets -->`)
  if (/<!--[\s\S]*?-->/.test(body)) {
    issues.push('html-comment')
  }

  // 2. Unchecked checklist items (e.g. `- [ ]`)
  const lines = body.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^- \[\s*\] /.test(trimmed)) {
      issues.push(`unchecked checklist: "${trimmed}"`)
      break
    }
  }

  // 3. TODO / TBD keywords (case-insensitive, word boundary)
  if (/\bTODO\b|\bTBD\b/i.test(body)) {
    issues.push('TODO/TBD placeholder')
  }

  // 4. Angle-bracket placeholders like `<...>` or `<feature name>`
  const bracketMatches = body.match(/<[^>]+>/g)
  if (bracketMatches) {
    issues.push(`angle-bracket placeholder: "${bracketMatches[0]}"`)
  }

  // 5. Ellipsis-in-angle or bracket placeholders: `...` used as placeholder
  //    in contexts like `[...]` or `<...>`
  if (/(\[.*?\.\.\..*?\])|(<.*?\.\.\..*?>)/g.test(body)) {
    issues.push('ellipsis placeholder')
  }

  // 6. Single-line bare dash placeholders (e.g. `-` on its own line)
  const bareDashLines = body.split('\n').filter((line) => line.trim() === '-')
  if (bareDashLines.length > 0) {
    issues.push(`bare-dash placeholder (${bareDashLines.length} lines)`)
  }

  return issues.length > 0 ? { body, issues } : null
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidationError = {
  body: string
  issues: string[]
}

/**
 * Human-readable error message suitable for throwing or logging.
 */
export const validationErrorToMessage = (error: ValidationError): string =>
  [
    `PR body validation failed: unresolved template scaffolding detected.`,
    ...error.issues.map((issue) => `  - ${issue}`),
    `Hint: remove all HTML comments, placeholders, and unchecked checklist items from the rendered PR body before sending to GitHub.`,
  ].join('\n')
