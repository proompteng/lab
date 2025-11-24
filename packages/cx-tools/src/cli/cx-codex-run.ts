#!/usr/bin/env bun

export const main = async () => {
  console.error('TODO(jng-010a): implement cx-codex-run')
  return 1
}

if (import.meta.main) {
  const code = await main()
  process.exit(typeof code === 'number' ? code : 1)
}
