import type { JangarRuntimeProfile } from './runtime-profile'
import { ensureRuntimeStartup } from './runtime-startup'
import { validateRuntimeProfileConfiguration } from './runtime-validation'

export const bootRuntimeProfile = (profile: JangarRuntimeProfile) => {
  validateRuntimeProfileConfiguration(profile)
  ensureRuntimeStartup(profile.startup)
}
