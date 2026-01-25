import {
  Activity,
  Boxes,
  Brain,
  Cloud,
  Database,
  Eye,
  KeyRound,
  Layers,
  Lock,
  Network,
  Server,
  ShieldCheck,
} from 'lucide-react'

const ICON_MAP = {
  Activity,
  Boxes,
  Brain,
  Cloud,
  Database,
  Eye,
  KeyRound,
  Layers,
  Lock,
  Network,
  Server,
  ShieldCheck,
}

export type IconName = keyof typeof ICON_MAP

export function Icon({ name, className, strokeWidth }: { name: IconName; className?: string; strokeWidth?: number }) {
  const Comp = ICON_MAP[name]
  return <Comp aria-hidden className={className} strokeWidth={strokeWidth ?? 1.5} />
}
