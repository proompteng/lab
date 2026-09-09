'use client'

import { api } from '@proompteng/backend/convex/_generated/api'
import {
  Alert,
  AlertDescription,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from '@proompteng/design/ui'
import { useQuery } from 'convex/react'
import { useMemo } from 'react'
import { Icon, type IconName } from '@/components/icon'
import { cn } from '@/lib/utils'

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL

const SKELETON_KEYS = ['model-alpha', 'model-beta', 'model-gamma', 'model-delta', 'model-epsilon', 'model-zeta']

type ModelCard = {
  slug: string
  title: string
  text: string
  provider: string
  category: string
  icon?: string
  tags: string[]
  featured: boolean
  order: number
  updatedAt: number
}

type ModelsGridProps = {
  limit?: number
  featured?: boolean
  className?: string
}

export default function ModelsGrid({ limit = 8, featured = true, className }: ModelsGridProps) {
  if (!convexUrl) {
    return null
  }

  return <LiveModelsGrid limit={limit} featured={featured} className={className} />
}

function LiveModelsGrid({
  limit,
  featured,
  className,
}: Required<Pick<ModelsGridProps, 'limit' | 'featured'>> & {
  className?: string
}) {
  const result = useQuery(api.models.list, { limit, featured })

  const models = useMemo(() => {
    if (result === undefined) {
      return undefined
    }

    if (!result || result.length === 0) {
      return []
    }

    return result
  }, [result])

  if (models === undefined) {
    return <ModelsSkeleton className={className} />
  }

  if (models.length === 0) {
    return (
      <EmptyState
        className={className}
        note="No models found. Run `bun run seed:models` or create models via the Agents workspace."
      />
    )
  }

  const [primary, ...rest] = models

  return (
    <div className={cn('space-y-4', className)}>
      <Alert className="border border-border/50 bg-card">
        <AlertDescription>Synced from Convex models table.</AlertDescription>
      </Alert>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {[primary, ...rest].map((model) => (
          <ModelCardView key={model.slug} model={model} />
        ))}
      </div>
    </div>
  )
}

function EmptyState({ note, className }: { note: string; className?: string }) {
  return (
    <div className={cn('space-y-4', className)}>
      <Alert className="border border-dashed border-border/60 bg-secondary/40">
        <AlertDescription>{note}</AlertDescription>
      </Alert>
    </div>
  )
}

function ModelsSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2', className)}>
      {SKELETON_KEYS.map((key) => (
        <Card key={key} className="border-border/60 bg-card/80">
          <CardHeader>
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="mt-2 h-3 w-1/2" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-16 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function ModelCardView({ model }: { model: ModelCard }) {
  const iconName = normalizeIcon(model.icon)
  const categoryLabel = formatLabel(model.category)

  return (
    <Card className="border-border/60 bg-card/80">
      <CardHeader className="space-y-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg border border-border/50 bg-muted/30 p-2">
            <Icon name={iconName} className="size-5" />
          </div>
          <div className="space-y-1">
            <CardTitle className="text-lg">{model.title}</CardTitle>
            <CardDescription className="text-xs uppercase tracking-[0.25em]">
              {model.provider} · {categoryLabel}
            </CardDescription>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {model.tags.map((tag) => (
            <Badge key={`${model.slug}-${tag}`} variant="outline">
              {tag}
            </Badge>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{model.text}</p>
      </CardContent>
    </Card>
  )
}

function normalizeIcon(icon?: string): IconName {
  const allowed: IconName[] = [
    'Activity',
    'Boxes',
    'Brain',
    'Cloud',
    'Database',
    'Eye',
    'KeyRound',
    'Layers',
    'Lock',
    'Network',
    'Server',
    'ShieldCheck',
  ]

  if (icon && allowed.includes(icon as IconName)) {
    return icon as IconName
  }

  return 'Boxes'
}

function formatLabel(value: string): string {
  if (!value) {
    return ''
  }

  return value
    .split(/[-_/\s]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ')
}
