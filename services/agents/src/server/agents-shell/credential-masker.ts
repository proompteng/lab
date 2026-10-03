// Only credential values are masked. Ordinary arguments, source, paths and output remain visible.
const credentialEnv =
  /(?:^|_)(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|PRIVATE_KEY|CREDENTIALS?)$|^AWS_SECRET_ACCESS_KEY$/i
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const marker = '[REDACTED_CREDENTIAL]'

type ValueState = { terminator: string | null; escaped: boolean; privateKey: boolean }

export class CredentialMasker {
  private pending = ''
  private receivedBytes = 0
  get consumedBytes() {
    return this.receivedBytes - Buffer.byteLength(this.pending)
  }
  private state: ValueState | null = null
  private readonly known: RegExp | null
  private readonly carry: number
  maskedValues = 0

  constructor(values: string[] = credentialValuesFromEnv()) {
    const secrets = Array.from(new Set(values.filter((value) => value.length >= 4))).sort((a, b) => b.length - a.length)
    this.known = secrets.length ? new RegExp(secrets.map(escapeRegex).join('|'), 'g') : null
    this.carry = Math.max(256, ...secrets.map((value) => value.length))
  }

  write(text: string, final = false) {
    this.receivedBytes += Buffer.byteLength(text)
    this.pending += text
    let output = ''
    while (this.pending.length > 0) {
      if (this.state) {
        if (this.state.privateKey) {
          const end = /-----END (?:[A-Z]+ )?PRIVATE KEY-----/.exec(this.pending)
          if (!end) {
            this.pending = final ? '' : this.pending.slice(-64)
            break
          }
          this.pending = this.pending.slice(end.index + end[0].length)
          this.state = null
          continue
        }
        let end = -1
        for (let i = 0; i < this.pending.length; i += 1) {
          const char = this.pending[i]
          if (this.state.escaped) {
            this.state.escaped = false
            continue
          }
          if (char === '\\' && this.state.terminator) {
            this.state.escaped = true
            continue
          }
          if (
            this.state.terminator
              ? this.state.terminator === '&'
                ? /[&#\s"'`)]/.test(char)
                : char === this.state.terminator
              : /[\s"'`,;)&}\]]/.test(char)
          ) {
            end = i
            break
          }
        }
        if (end < 0) {
          this.pending = ''
          break
        }
        // Keep the delimiter, including a closing quote, in the operational transcript.
        output += this.pending[end]
        this.pending = this.pending.slice(end + 1)
        this.state = null
        continue
      }
      let safeEnd = final ? this.pending.length : Math.max(0, this.pending.length - this.carry)
      if (!final) {
        // Keep incomplete value introducers, not an arbitrary prefix of a credential context.
        // This also distinguishes URL userinfo from an ordinary host:port URL.
        const incomplete = [
          /(?:--user(?:=|\s+)|-u\s*)[^\s:]*$/i,
          /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*$/i,
          /(?:--token\b|["']token["'])\s*(?:[:=]\s*)?$/i,
          /\b(?:password|passwd|secret|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key)["']?\s*(?:[:=]\s*)?$/i,
          /\b(?:Authorization|Proxy-Authorization)["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic)\s*)?$/i,
        ].flatMap((pattern) => {
          const match = pattern.exec(this.pending)
          return match ? [match.index] : []
        })
        if (incomplete.length) safeEnd = Math.min(safeEnd, ...incomplete)
        if (safeEnd === 0 && this.pending.length > Math.max(65_536, this.carry * 2))
          throw new Error('credential context exceeded bounded scanner capacity; output capture stopped')
        if (safeEnd > 0 && /[\uD800-\uDBFF]/.test(this.pending[safeEnd - 1])) safeEnd -= 1
      }
      if (!safeEnd) break
      const patterns = [
        { regex: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g, kind: 'pem' },
        { regex: /\b(?:Authorization|Proxy-Authorization)["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+/gi, kind: 'value' },
        { regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:(?=[^\s/@]*@)/gi, kind: 'url' },
        { regex: /[?&](?:token|access_token|refresh_token|api_key|apikey|password|secret)=/gi, kind: 'query' },
        {
          regex:
            /\b(?:password|passwd|secret|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]\s*(["']?)/gi,
          kind: 'assignment',
        },
        {
          regex: /\b(?:[A-Z][A-Z0-9]*_)*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|PRIVATE_KEY)\s*=\s*(["']?)/g,
          kind: 'assignment',
        },
        { regex: /\b(?:gh[pousr]_[A-Za-z0-9]|github_pat_[A-Za-z0-9]|xox[baps]-[A-Za-z0-9])/g, kind: 'format' },
      ]
      patterns.push({ regex: /["'](?:token|secret)["']\s*:\s*(["'])/gi, kind: 'assignment' })
      patterns.push({ regex: /\bAWS_SECRET_ACCESS_KEY\s*=\s*(["']?)/g, kind: 'assignment' })
      patterns.push({ regex: /(?:--user(?:=|\s+)|-u\s*)["']?[^\s:"']+:/g, kind: 'value' })
      patterns.push({
        regex: /--(?:password|passwd|token|api-key|client-secret|oauth2-bearer)\b(?:[\t ]*=[\t ]*|[\t ]+)(["']?)/gi,
        kind: 'assignment',
      })
      let found: { index: number; text: string; kind: string; quote?: string } | null = null
      for (const { regex, kind } of patterns) {
        const match = regex.exec(this.pending)
        if (match && (!found || match.index < found.index))
          found = { index: match.index, text: match[0], kind, quote: match[1] }
      }
      if (this.known) {
        this.known.lastIndex = 0
        const match = this.known.exec(this.pending)
        if (match && (!found || match.index <= found.index))
          found = { index: match.index, text: match[0], kind: 'known' }
      }
      if (!found || found.index >= safeEnd) {
        output += this.pending.slice(0, safeEnd)
        this.pending = this.pending.slice(safeEnd)
        continue
      }
      output += this.pending.slice(0, found.index)
      if (found.kind !== 'known' && found.kind !== 'format' && found.kind !== 'pem') output += found.text
      this.pending = this.pending.slice(found.index + found.text.length)
      if (this.pending.startsWith(marker) && !['known', 'format', 'pem'].includes(found.kind)) {
        output += marker
        this.pending = this.pending.slice(marker.length)
        continue
      }
      output += marker
      this.maskedValues += 1
      if (found.kind !== 'known') {
        this.state = {
          terminator: found.kind === 'url' ? '@' : found.kind === 'query' ? '&' : found.quote || null,
          escaped: false,
          privateKey: found.kind === 'pem',
        }
      }
    }
    return output
  }
}

export const credentialValuesFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  Object.entries(env).flatMap(([key, value]) =>
    credentialEnv.test(key) && value && value.length >= 4
      ? [value, Buffer.from(value).toString('base64'), encodeURIComponent(value)]
      : [],
  )

export const maskCredentialValues = (value: string, secrets?: string[]) => {
  const masker = new CredentialMasker(secrets)
  return { text: masker.write(value, true), maskedValues: masker.maskedValues }
}
