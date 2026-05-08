export const up = async () => {
  // This is a performance-only index. Creating it from the app startup migrator
  // timed out on production data and left Jangar unable to serve health checks.
  // Keep runtime migration non-blocking; add the index later through an
  // operational/concurrent migration path that does not run in process startup.
}

export const down = async () => {}
