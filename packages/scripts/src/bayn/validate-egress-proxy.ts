const requiredAlpacaHosts = new Set(['paper-api.alpaca.markets', 'api.alpaca.markets'])

export interface BaynEgressProxyContract {
  readonly aclName: string
  readonly allowedHosts: readonly string[]
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

  const domainLine = exactlyOne(lines, (line) => /^acl\s+\S+\s+dstdomain\s+/.test(line), 'destination-domain ACL')
  const [, aclName, directive, ...allowedHosts] = domainLine.split(/\s+/)
  if (aclName === undefined || directive !== 'dstdomain' || allowedHosts.length === 0) {
    throw new Error('destination-domain ACL is incomplete')
  }
  if (allowedHosts.length !== requiredAlpacaHosts.size || allowedHosts.some((host) => !requiredAlpacaHosts.has(host))) {
    throw new Error('destination-domain ACL must contain only the Alpaca sandbox and live trading API hosts')
  }

  const denyNonConnect = lines.indexOf('http_access deny !CONNECT')
  const denyNonTls = lines.indexOf('http_access deny CONNECT !SSL_ports')
  const denyUnlisted = lines.indexOf(`http_access deny !${aclName}`)
  const allowAlpaca = lines.indexOf(`http_access allow CONNECT ${aclName}`)
  const denyAll = lines.indexOf('http_access deny all')
  if ([denyNonConnect, denyNonTls, denyUnlisted, allowAlpaca, denyAll].some((index) => index < 0)) {
    throw new Error('proxy access policy is missing a required fail-closed rule')
  }
  if (
    !(denyNonConnect < denyNonTls && denyNonTls < denyUnlisted && denyUnlisted < allowAlpaca && allowAlpaca < denyAll)
  ) {
    throw new Error('proxy access policy rules are not in fail-closed order')
  }

  const allowRules = lines.filter((line) => line.startsWith('http_access allow '))
  if (allowRules.length !== 1 || allowRules[0] !== `http_access allow CONNECT ${aclName}`) {
    throw new Error('proxy must have exactly one allow rule for CONNECT to the exact Alpaca ACL')
  }

  return { aclName, allowedHosts: [...allowedHosts].sort() }
}
