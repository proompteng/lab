type FreshnessBadgeProps = {
  gameVersion: string
  lastVerified: string
}

export function FreshnessBadge({ gameVersion, lastVerified }: FreshnessBadgeProps) {
  return (
    <span className="inline-flex items-center rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-200">
      Verified {lastVerified} against {gameVersion}
    </span>
  )
}
