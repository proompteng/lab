import * as migration_20260125_011322_init from './20260125_011322_init'

export const migrations = [
  {
    up: migration_20260125_011322_init.up,
    down: migration_20260125_011322_init.down,
    name: '20260125_011322_init',
  },
]
