#!/usr/bin/env bun

/**
 * Delete all Tailscale devices except a provided allowlist.
 *
 * Usage (dry run first!):
 *   bun run scripts/tailscale-prune-except.ts --keep nuc,nova,iphone182,gregkonushs-macbook-pro,madmaxmachine --dry-run
 *
 * Then actually delete:
 *   bun run scripts/tailscale-prune-except.ts --keep nuc,nova,iphone182,gregkonushs-macbook-pro,madmaxmachine -y
 *
 * Auth:
 *   Reads TS_API_KEY or TAILSCALE_API_KEY from env.
 *
 * Notes:
 * - Matches against `device.hostname`, and also `device.name` shortname (before the first '.').
 * - Always requires `--keep ...`; defaults to `--dry-run` unless `-y/--yes` is provided.
 */

type Args = {
  tailnet: string
  dryRun: boolean
  yes: boolean
  keep: string[]
}

type DeviceRecord = {
  id?: string
  name?: string
  hostname?: string
}

function parseArgs(argv: string[]): Args {
  let tailnet = '-'
  let dryRun = false
  let yes = false
  let keepRaw = ''

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '-t':
      case '--tailnet':
        tailnet = argv[++i] ?? '-'
        break
      case '--dry-run':
        dryRun = true
        break
      case '-y':
      case '--yes':
        yes = true
        break
      case '--keep':
        keepRaw = argv[++i] ?? ''
        break
      default:
        break
    }
  }

  const keep = keepRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    tailnet: tailnet.trim().length > 0 ? tailnet : '-',
    dryRun,
    yes,
    keep,
  }
}

function shortName(name: string): string {
  const idx = name.indexOf('.')
  return idx === -1 ? name : name.slice(0, idx)
}

async function confirm(prompt: string): Promise<boolean> {
  process.stdout.write(`${prompt} [y/N] `)
  const chunks: Uint8Array[] = []
  return await new Promise<boolean>((resolve) => {
    const decoder = new TextDecoder()
    const onData = (buf: Buffer) => {
      chunks.push(new Uint8Array(buf))
      if (buf.includes(10) || buf.includes(13)) {
        process.stdin.off('data', onData)
        const input = decoder.decode(Buffer.concat(chunks)).trim().toLowerCase()
        resolve(input === 'y' || input === 'yes')
      }
    }
    process.stdin.on('data', onData)
  })
}

async function main() {
  const { tailnet, dryRun: dryRunFlag, yes, keep } = parseArgs(process.argv)
  if (keep.length === 0) {
    console.error('Error: --keep is required (comma-separated hostnames).')
    process.exit(2)
  }

  const apiKey = process.env.TS_API_KEY || process.env.TAILSCALE_API_KEY
  if (!apiKey) {
    console.error('Error: set TS_API_KEY or TAILSCALE_API_KEY.')
    process.exit(2)
  }

  const keepSet = new Set(keep)
  const dryRun = dryRunFlag || !yes

  const resp = await fetch(`https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(tailnet)}/devices`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  })
  if (!resp.ok) {
    console.error(`Failed to list devices: ${resp.status} ${resp.statusText}`)
    process.exit(1)
  }
  const payload = (await resp.json()) as { devices?: DeviceRecord[] } | DeviceRecord[]
  const devices = Array.isArray(payload) ? payload : (payload.devices ?? [])

  const toDelete = devices.filter((device) => {
    const hostname = device.hostname ?? ''
    const name = device.name ?? ''
    const nameShort = shortName(name)
    return !(keepSet.has(hostname) || keepSet.has(name) || keepSet.has(nameShort))
  })

  console.log(`Keep allowlist (${keep.length}): ${keep.join(', ')}`)
  console.log(`Found ${devices.length} device(s) total.`)
  console.log(`Will delete ${toDelete.length} device(s).`)

  if (toDelete.length === 0) {
    console.log('Nothing to do.')
    return
  }

  console.log('Delete candidates:')
  for (const d of toDelete) {
    const label = d.hostname ?? shortName(d.name ?? '') ?? d.name ?? d.id ?? '<unknown>'
    console.log(`- ${label}`)
  }

  if (dryRun) {
    console.log('Dry run enabled; nothing deleted.')
    if (!yes) {
      console.log('Re-run with -y to actually delete.')
    }
    return
  }

  if (!yes) {
    const confirmed = await confirm('Delete all listed devices?')
    if (!confirmed) {
      console.log('Aborted.')
      return
    }
  }

  let deleted = 0
  for (const device of toDelete) {
    const id = device.id
    if (!id) continue
    const delResp = await fetch(`https://api.tailscale.com/api/v2/device/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (delResp.ok) {
      console.log(`Deleted ${device.hostname ?? device.name ?? id}`)
      deleted += 1
    } else {
      console.error(`Failed to delete ${device.hostname ?? device.name ?? id}: ${delResp.status} ${delResp.statusText}`)
    }
  }

  console.log(`Done. Deleted ${deleted}/${toDelete.length}.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
