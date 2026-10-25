const requiredHosts = new Set([
  'paper-api.alpaca.markets',
  'api.alpaca.markets',
  'data.alpaca.markets',
  'api.openai.com',
  'api.typesafe.ai',
  'www.sec.gov',
  'data.sec.gov',
  'www.bls.gov',
  'www.federalreserve.gov',
])

export interface BaynEgressProxyContract {
  readonly aclName: string
  readonly allowedHosts: readonly string[]
  readonly openCodeAllowedHosts: readonly string[]
}

const meaningfulLines = (source: string): readonly string[] =>
  source
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line.length > 0)

const exactlyOne = (lines: readonly string[], predicate: (line: string) => boolean, name: string): string => {
  const matches = lines.filter(predicate)
  if (matches.length !== 1) throw new Error(`expected exactly one ${name}, found ${matches.length}`)
  const match = matches[0]
  if (match === undefined) throw new Error(`missing ${name}`)
  return match
}

export const validateBaynEgressProxy = (source: string): BaynEgressProxyContract => {
  const lines = meaningfulLines(source)
  exactlyOne(lines, (line) => line === 'acl SSL_ports port 443', 'TLS port ACL')
  exactlyOne(lines, (line) => line === 'acl CONNECT method CONNECT', 'CONNECT method ACL')

  exactlyOne(lines, (line) => line === 'http_port 3128 name=trading', 'trading listener')
  exactlyOne(lines, (line) => line === 'http_port 3129 name=opencode', 'OpenCode listener')
  if (lines.filter((line) => line.startsWith('http_port ')).length !== 2) throw new Error('Unexpected proxy listener')
  exactlyOne(lines, (line) => line === 'acl opencode_listener myportname opencode', 'OpenCode listener ACL')
  exactlyOne(lines, (line) => line === 'acl opencode_api dstdomain opencode.ai', 'OpenCode destination ACL')
  if (lines.filter((line) => /^acl\s+\S+\s+dstdomain\s+/.test(line)).length !== 2)
    throw new Error('Unexpected destination ACL')
  const domainLine = exactlyOne(
    lines,
    (line) => line.startsWith('acl trading_api dstdomain '),
    'trading destination ACL',
  )
  const [, aclName, directive, ...allowedHosts] = domainLine.split(/\s+/)
  if (aclName === undefined || directive !== 'dstdomain' || allowedHosts.length === 0) {
    throw new Error('destination-domain ACL is incomplete')
  }
  if (
    allowedHosts.length !== requiredHosts.size ||
    new Set(allowedHosts).size !== requiredHosts.size ||
    allowedHosts.some((host) => !requiredHosts.has(host))
  ) {
    throw new Error(
      'destination-domain ACL must contain exactly the Alpaca, OpenAI, TypeSafe, SEC, BLS and Federal Reserve hosts',
    )
  }

  const rules = [
    'http_access deny !CONNECT',
    'http_access deny CONNECT !SSL_ports',
    'http_access deny opencode_listener !opencode_api',
    `http_access deny !opencode_listener !${aclName}`,
    'http_access deny blocked_private_v4',
    'http_access deny blocked_private_v6',
    'http_access allow CONNECT opencode_listener opencode_api',
    `http_access allow CONNECT !opencode_listener ${aclName}`,
    'http_access deny all',
  ]
  const actualRules = lines.filter((line) => line.startsWith('http_access '))
  if (JSON.stringify(actualRules) !== JSON.stringify(rules))
    throw new Error('Proxy listeners must retain their separate exact hosts and fail-closed rule order')

  return { aclName, allowedHosts: [...allowedHosts].sort(), openCodeAllowedHosts: ['opencode.ai'] }
}
