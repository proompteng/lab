#!/usr/bin/env bun

/**
 * Purge every Tailscale device whose hostname starts with kube-master* or kube-worker*.
 *
 * Usage (dry run first!):
 *   TS_API_KEY=tskey-xxxx bun run scripts/tailscale-clean-kube.ts --dry-run
 *
 * Then actually delete:
 *   TS_API_KEY=tskey-xxxx bun run scripts/tailscale-clean-kube.ts -y
 *
 * Optional flags:
 *   -t, --tailnet   Tailnet name (defaults to "-")
 *       --dry-run   Only print actions
 *   -y, --yes       Skips confirmation prompt
 */

type Args = {
  tailnet: string
  dryRun: boolean
  yes: boolean
}

function parseArgs(argv: string[]): Args {
  let tailnet = '-'
  let dryRun = false
  let yes = false
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
      default:
        break
    }
  }
  return { tailnet: tailnet.trim().length > 0 ? tailnet : '-', dryRun, yes }
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
  const { tailnet, dryRun, yes } = parseArgs(process.argv)
  const apiKey = process.env.TS_API_KEY || process.env.TAILSCALE_API_KEY
  if (!apiKey) {
    console.error('Error: set TS_API_KEY or TAILSCALE_API_KEY.')
    process.exit(2)
  }

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

  type DeviceRecord = {
    id?: string
    name?: string
    hostname?: string
  }

  const targets = devices.filter((device) => {
    const name = device?.name ?? ''
    const hostname = device?.hostname ?? ''
    const matchTarget = (value: string) => value.startsWith('kube-master') || value.startsWith('kube-worker')
    return matchTarget(name) || matchTarget(hostname)
  })

  if (targets.length === 0) {
    console.log('No kube-master*/kube-worker* devices found.')
    return
  }

  console.log(`Found ${targets.length} matching device(s):`)
  for (const device of targets) {
    console.log(`- ${device.hostname ?? device.name ?? device.id}`)
  }

  if (dryRun) {
    console.log('Dry run enabled; nothing deleted.')
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
  for (const device of targets) {
    const id: string | undefined = device?.id
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
  console.log(`Done. Deleted ${deleted}/${targets.length}.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
