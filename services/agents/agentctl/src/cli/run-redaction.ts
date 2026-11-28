import { stripVTControlCharacters } from 'node:util'

// A failed kubectl command can echo manifest or log contents. Keep only a recognized status reason.
export const kubeStatusSuffix = (message: string) => {
  const reason = /\b(?:Forbidden|Unauthorized|AlreadyExists|NotFound|Invalid|BadRequest)\b/i.exec(message)?.[0]
  return reason ? ` (${reason})` : ''
}

// Run text is untrusted. Redact after joining deltas so credentials split across events are still masked.
export const redactRunText = (value: string, knownToken?: string) => {
  const text = knownToken ? value.replaceAll(knownToken, '[redacted]') : value
  return stripVTControlCharacters(text)
    .replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === '\n' || char === '\t' ? char : ''))
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted key]')
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?):\/\/[^\s<>"'`]+/gi, '[redacted URL]')
    .replace(/\bhttps?:\/\/[^\s/<>"'`]+@[^\s<>"'`]+/gi, '[redacted URL]')
    .replace(/(\bhttps?:\/\/[^\s<>"'`?#]+)[?#][^\s<>"'`)]*/gi, '$1')
    .replace(
      /\b((?:[\w.-]+[_-])?(?:password|passphrase|passwd|token|secret(?:[-_ ]?(?:access[-_ ]?)?key)?|api[-_ ]?key|authorization)["'`]?[ \t]*[:=]\s*)(?:(?:Bearer|Basic)[ \t]+)?(?:"(?:[^"\\\n]|\\.)*(?:"|$)|'(?:[^'\\\n]|\\.)*(?:'|$)|`[^`\n]*(?:`|$)|[^\s,;}\]]+)/gim,
      '$1[redacted]',
    )
    .replace(/\b(?:Bearer|Basic)\s+[^\s<>"'`,;]+/gi, '[redacted authorization]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-(?:proj-|svcacct-)?|xox[baprs]-|npm_|glpat-)[\w-]+/g, '[redacted token]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted key]')
    .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]*/g, '[redacted token]')
}
