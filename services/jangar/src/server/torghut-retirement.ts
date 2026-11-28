type EnvSource = Record<string, string | undefined>

export const isTorghutLegacyRetired = (env: EnvSource = process.env) =>
  env.JANGAR_TORGHUT_LEGACY_RETIRED?.trim().toLowerCase() === 'true'

const retiredRoutePrefixes = [
  '/api/torghut/trading',
  '/api/torghut/decision-engine',
  '/api/torghut/simulation',
  '/api/whitepapers',
]

export const guardRetiredTorghutRoute = (routePath: string, env: EnvSource = process.env) => {
  if (!isTorghutLegacyRetired(env)) return undefined
  if (!retiredRoutePrefixes.some((prefix) => routePath === prefix || routePath.startsWith(`${prefix}/`))) {
    return undefined
  }
  return Response.json(
    { error: 'torghut_runtime_retired', message: 'The legacy Torghut trading and research runtime has been retired.' },
    { status: 410 },
  )
}
