# Olden Era Wiki Deployment Design

**Goal:** Deploy `https://olden.proompteng.ai` as an unofficial, source-attributed Heroes of Might and Magic: Olden Era player wiki covering the information needed to learn, play, compare factions, and keep up with Early Access changes.

**Architecture:** Create a dedicated `apps/olden` Next.js 16 + Fumadocs MDX app, with curated MDX strategy pages and typed reference data for factions, units, heroes, skills, spells, artifacts, laws, buildings, map objects, game modes, and patch freshness. Deploy it as a standalone Kubernetes workload through Argo CD at `olden.proompteng.ai`, with Cloudflare Tunnel routing `olden.proompteng.ai` directly to the in-cluster `olden` Service.

**Tech Stack:** Bun 1.3.14, Node 24.11.1, Next.js 16, React 19, Fumadocs, Tailwind CSS 4, MDX, Bun test, GitHub Actions, Docker BuildKit, Kustomize, Cloudflare Tunnel, Argo CD ApplicationSet, Argo CD Image Updater.

---

## Source Facts Captured

Use these as the first content baseline, then refresh before launch because the game is in Early Access.

- Steam page: released on April 30, 2026; Early Access is fully playable with 6 unique factions, three game modes in single-player and multiplayer, opening campaign act, scenarios, and map editor. Source: <https://store.steampowered.com/app/3105440/Heroes_of_Might_and_Magic_Olden_Era/>
- Official wiki main page: categories include Factions, Magic, Heroes, Units, Spells, Combat System, Skills, Laws, Artifacts, Objects, Developer Diaries, and Beginner's Guide; latest client patch shown during research was `v0.80.16`; content is Creative Commons Attribution-ShareAlike unless otherwise noted. Source: <https://wiki.hoodedhorse.com/Heroes_of_Might_and_Magic_Olden_Era/Main_Page>
- Official wiki factions page: current factions are Temple, Necropolis, Grove, Hive, Schism, and Dungeon. Source: <https://wiki.hoodedhorse.com/Heroes_of_Might_and_Magic_Olden_Era/Factions>
- Ubisoft roadmap on May 28, 2026: near-term planned updates include teamplay mode, hero skill rebalance, random map generator improvements, observer mode, elite class rework, and matchmaking improvements; broader Early Access goals include Underground terrain, map editor improvements, Ironman campaign mode, campaign completion, map sharing, and a new PvE mode. Source: <https://news.ubisoft.com/en-au/article/78nufFYRzpa1Vcp1Y8LnNF/heroes-of-might-and-magic-olden-era-early-access-roadmap>

Content rules:

- The site must identify itself as an unofficial fan/player wiki.
- Use official wiki data under CC BY-SA only with attribution and license notice.
- Write original strategy prose. Do not bulk-copy third-party prose from Steam, Ubisoft, other wikis, news sites, or guides.
- Do not ship official logos, screenshots, videos, or creature art unless their license or media-kit permission is recorded in `apps/olden/content/docs/meta/legal.mdx`.
- Every factual page must show `lastVerified`, source links, and the game/client patch version used for that page.

## File Structure

Create:

- `apps/olden/package.json` - app package, scripts, exact dependencies matching `apps/docs` where possible.
- `apps/olden/Dockerfile` - production Next standalone image for `apps/olden`.
- `apps/olden/next.config.mjs` - Next standalone output.
- `apps/olden/postcss.config.mjs` - Tailwind 4 PostCSS config.
- `apps/olden/source.config.ts` - Fumadocs MDX source configuration.
- `apps/olden/tsconfig.json` - app TypeScript config.
- `apps/olden/app/global.css` - Tailwind and wiki theme tokens.
- `apps/olden/app/layout.tsx` - global metadata and provider.
- `apps/olden/app/(home)/layout.tsx` - Fumadocs home shell.
- `apps/olden/app/(home)/page.tsx` - first viewport and major wiki entry points.
- `apps/olden/app/docs/layout.tsx` - docs shell.
- `apps/olden/app/docs/[[...slug]]/page.tsx` - MDX page renderer.
- `apps/olden/app/api/search/route.ts` - Fumadocs search endpoint.
- `apps/olden/app/llms-full.txt/route.ts` - LLM-readable full text export.
- `apps/olden/lib/layout.shared.tsx` - nav/search/theme options.
- `apps/olden/lib/source.ts` - Fumadocs source loader and `llms-full` helper.
- `apps/olden/mdx-components.tsx` - MDX component registry.
- `apps/olden/src/data/olden/schema.ts` - typed wiki data contracts.
- `apps/olden/src/data/olden/sources.ts` - canonical source registry.
- `apps/olden/src/data/olden/factions.ts` - faction metadata and first-pass strategy labels.
- `apps/olden/src/data/olden/game-modes.ts` - modes and player expectations.
- `apps/olden/src/data/olden/roadmap.ts` - Early Access roadmap facts.
- `apps/olden/src/components/wiki/source-note.tsx` - source/verification callout.
- `apps/olden/src/components/wiki/faction-grid.tsx` - faction overview cards.
- `apps/olden/src/components/wiki/reference-table.tsx` - sortable reference tables.
- `apps/olden/src/components/wiki/freshness-badge.tsx` - patch/version badge.
- `apps/olden/src/components/wiki/__tests__/content-integrity.test.ts` - data/content integrity gate.
- `apps/olden/content/docs/index.mdx` - wiki landing docs page.
- `apps/olden/content/docs/getting-started/index.mdx` - beginner flow.
- `apps/olden/content/docs/getting-started/first-week.mdx` - first week checklist.
- `apps/olden/content/docs/fundamentals/*.mdx` - adventure map, economy, movement, combat, heroes, towns, magic, skills, morale/luck/focus, artifacts.
- `apps/olden/content/docs/game-modes/*.mdx` - campaign, classic, single hero, arena, scenarios, multiplayer, map editor.
- `apps/olden/content/docs/factions/*.mdx` - one page each for Temple, Necropolis, Grove, Dungeon, Hive, Schism.
- `apps/olden/content/docs/reference/*.mdx` - heroes, units, spells, skills, laws, artifacts, buildings, map objects.
- `apps/olden/content/docs/strategy/*.mdx` - build orders, scouting, creeping, army preservation, faction counters, PvP basics.
- `apps/olden/content/docs/meta/legal.mdx` - attribution, license, trademark, and art policy.
- `apps/olden/content/docs/meta/sources.mdx` - source registry and freshness policy.
- `packages/scripts/src/olden/build-image.ts` - build and push `registry.ide-newton.ts.net/lab/olden`.
- `packages/scripts/src/olden/deploy-service.ts` - update image tag/digest and optionally apply manifests when explicitly invoked.
- `argocd/applications/olden/deployment.yaml` - app deployment.
- `argocd/applications/olden/service.yaml` - service.
- `argocd/applications/olden/kustomization.yaml` - image tag and resources.
- `argocd/applications/cloudflare/configmap.yaml` - explicit Cloudflare Tunnel ingress route for `olden.proompteng.ai`.
- `.github/workflows/docker-build-push.yaml` - publish `registry.ide-newton.ts.net/lab/olden:<semver>` on main.
- `.github/workflows/pull-request.yml` - run Olden tests/build on PRs.
- `.github/workflows/release-pr-automerge.yml` - allow Image Updater release PRs for Olden to auto-merge.

Modify:

- `package.json` - add `dev:olden`, `build:olden`, `start:olden`, `lint:olden`, `test:olden`, and `olden:deploy`.
- `argocd/applicationsets/product.yaml` - add enabled `olden` product ApplicationSet entry in namespace `olden`.
- `argocd/applications/argocd/base/image-updater-product.yaml` - add Olden Image Updater application reference.

## Information Architecture

The wiki is complete only when these top-level sections exist and have source-backed pages:

| Section         | Required pages                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Getting Started | install/access, UI tour, first week, first town, first hero, glossary                                                                                                                               |
| Fundamentals    | turn structure, resources, adventure map, scouting, movement, native terrain, town building, creature growth, hero attributes, skills, spells, artifacts, morale, luck, focus, combat, siege combat |
| Game Modes      | campaign, classic, single hero, arena, scenario maps, multiplayer, hot seat/shared screen, map editor                                                                                               |
| Factions        | Temple, Necropolis, Grove, Dungeon, Hive, Schism; each has identity, native terrain, mechanics, laws, heroes, units, build priorities, power spikes, counters                                       |
| Reference       | heroes, units, unit abilities, spells, magic schools, skills/subskills, laws, artifacts, artifact sets, buildings, map objects                                                                      |
| Strategy        | first week, creeping, economy, build orders, chaining, army preservation, scouting patterns, faction matchups, PvP etiquette, common mistakes                                                       |
| Meta            | source policy, attribution, Early Access freshness, changelog, roadmap tracker                                                                                                                      |

## Task 1: Scaffold `apps/olden`

**Files:**

- Create: `apps/olden/package.json`
- Create: `apps/olden/next.config.mjs`
- Create: `apps/olden/postcss.config.mjs`
- Create: `apps/olden/source.config.ts`
- Create: `apps/olden/tsconfig.json`
- Create: `apps/olden/app/global.css`
- Create: `apps/olden/app/layout.tsx`
- Create: `apps/olden/app/(home)/layout.tsx`
- Create: `apps/olden/app/(home)/page.tsx`
- Create: `apps/olden/app/docs/layout.tsx`
- Create: `apps/olden/app/docs/[[...slug]]/page.tsx`
- Create: `apps/olden/app/api/search/route.ts`
- Create: `apps/olden/app/llms-full.txt/route.ts`
- Create: `apps/olden/lib/layout.shared.tsx`
- Create: `apps/olden/lib/source.ts`
- Create: `apps/olden/mdx-components.tsx`
- Modify: `package.json`

- [ ] **Step 1: Copy the docs app shape without copying its content**

Run:

```bash
mkdir -p apps/olden
cp -R apps/docs/app apps/docs/lib apps/docs/mdx-components.tsx apps/docs/source.config.ts apps/docs/postcss.config.mjs apps/docs/tsconfig.json apps/olden/
```

Expected: `apps/olden/app`, `apps/olden/lib`, and `apps/olden/source.config.ts` exist.

- [ ] **Step 2: Write the app package**

Replace `apps/olden/package.json` with:

```json
{
  "name": "olden",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "next build",
    "dev": "next dev --turbo",
    "start": "next start",
    "postinstall": "fumadocs-mdx",
    "test": "bun test",
    "lint": "bunx oxfmt --check .",
    "format": "bunx oxfmt .",
    "lint:oxlint": "oxlint --config ../../.oxlintrc.json .",
    "lint:oxlint:type": "oxlint --config ../../.oxlintrc.json --type-aware --tsconfig ./tsconfig.json ."
  },
  "dependencies": {
    "@proompteng/design": "workspace:*",
    "fumadocs-core": "16.8.7",
    "fumadocs-mdx": "14.3.2",
    "fumadocs-ui": "16.8.7",
    "lucide-react": "^1.14.0",
    "next": "16.2.4",
    "react": "19.2.5",
    "react-dom": "19.2.5"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.2.4",
    "@types/mdx": "^2.0.13",
    "@types/node": "25.6.0",
    "@types/react": "19.2.14",
    "@types/react-dom": "19.2.3",
    "postcss": "^8.5.14",
    "tailwindcss": "^4.2.4",
    "typescript": "^6.0.3"
  }
}
```

- [ ] **Step 3: Write Next standalone config**

Create `apps/olden/next.config.mjs`:

```js
import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
}

export default withMDX(nextConfig)
```

- [ ] **Step 4: Update metadata and layout identity**

Replace `apps/olden/app/layout.tsx` with:

```tsx
import '@/app/global.css'
import { RootProvider } from 'fumadocs-ui/provider/next'
import type { Metadata } from 'next'

const siteUrl = 'https://olden.proompteng.ai'
const siteTitle = 'Olden Era Wiki'
const siteDescription =
  'Unofficial player wiki for Heroes of Might and Magic: Olden Era factions, units, heroes, spells, strategy, and Early Access changes.'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: siteTitle,
    template: '%s | Olden Era Wiki',
  },
  description: siteDescription,
  alternates: {
    canonical: siteUrl,
  },
  openGraph: {
    title: siteTitle,
    description: siteDescription,
    url: siteUrl,
    siteName: siteTitle,
  },
  twitter: {
    card: 'summary_large_image',
    title: siteTitle,
    description: siteDescription,
  },
}

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col bg-fd-background font-sans">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  )
}
```

- [ ] **Step 5: Update shared layout options**

Replace `apps/olden/lib/layout.shared.tsx` with:

```tsx
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

const baseConfig: BaseLayoutProps = {
  nav: {
    enabled: true,
    title: 'Olden Era Wiki',
    url: '/',
  },
  links: [
    {
      type: 'main',
      text: 'Wiki',
      url: '/docs',
      active: 'nested-url',
    },
    {
      type: 'main',
      text: 'Sources',
      url: '/docs/meta/sources',
      active: 'url',
    },
    {
      type: 'main',
      text: 'Official Wiki',
      url: 'https://wiki.hoodedhorse.com/Heroes_of_Might_and_Magic_Olden_Era/Main_Page',
      external: true,
    },
  ],
  searchToggle: {
    enabled: true,
  },
  themeSwitch: {
    enabled: true,
    mode: 'light-dark-system',
  },
}

export function baseOptions(): BaseLayoutProps {
  return {
    ...baseConfig,
    links: [...(baseConfig.links ?? [])],
  }
}
```

- [ ] **Step 6: Add root scripts**

Modify root `package.json` scripts:

```json
"dev:olden": "bun run --filter olden dev",
"build:olden": "bun run --filter olden build",
"start:olden": "bun run --filter olden start",
"lint:olden": "bun run --filter olden lint",
"test:olden": "bun run --filter olden test",
"olden:deploy": "bun run packages/scripts/src/olden/deploy-service.ts"
```

Expected: `bun run build:olden` resolves the workspace script after dependencies are installed.

- [ ] **Step 7: Run the first scaffold build**

Run:

```bash
bun install
bun run --filter olden postinstall
bun run build:olden
```

Expected: build fails only if copied docs content still references the old app content tree. Fix references to `apps/olden/content/docs` before moving on.

- [ ] **Step 8: Commit scaffold**

```bash
git add package.json bun.lock apps/olden
git commit -m "feat(olden): scaffold wiki app"
```

## Task 2: Add Typed Wiki Data Contracts

**Files:**

- Create: `apps/olden/src/data/olden/schema.ts`
- Create: `apps/olden/src/data/olden/sources.ts`
- Create: `apps/olden/src/data/olden/factions.ts`
- Create: `apps/olden/src/data/olden/game-modes.ts`
- Create: `apps/olden/src/data/olden/roadmap.ts`

- [ ] **Step 1: Create source and entity schema**

Write `apps/olden/src/data/olden/schema.ts`:

```ts
export type SourceKind = 'official-wiki' | 'steam' | 'ubisoft-news' | 'manual-verification'

export type WikiSource = {
  id: string
  kind: SourceKind
  title: string
  url: string
  license: 'CC-BY-SA-4.0' | 'Steam Subscriber Agreement' | 'Ubisoft News Terms' | 'Original'
  retrievedAt: string
}

export type Verification = {
  lastVerified: string
  gameVersion: string
  sourceIds: string[]
}

export type FactionId = 'temple' | 'necropolis' | 'grove' | 'dungeon' | 'hive' | 'schism'

export type Faction = {
  id: FactionId
  name: string
  nativeTerrain: string
  identity: string
  beginnerFit: 'easy' | 'medium' | 'hard'
  playstyleTags: string[]
  strengths: string[]
  weaknesses: string[]
  coreQuestions: string[]
  verification: Verification
}

export type GameMode = {
  id: string
  name: string
  playerPromise: string
  goodFor: string[]
  watchOutFor: string[]
  verification: Verification
}

export type RoadmapItem = {
  name: string
  horizon: 'near-term' | 'early-access' | 'long-term'
  playerImpact: string
  verification: Verification
}
```

- [ ] **Step 2: Register canonical sources**

Write `apps/olden/src/data/olden/sources.ts`:

```ts
import type { WikiSource } from './schema'

export const wikiSources = [
  {
    id: 'steam-store-3105440',
    kind: 'steam',
    title: 'Heroes of Might and Magic: Olden Era on Steam',
    url: 'https://store.steampowered.com/app/3105440/Heroes_of_Might_and_Magic_Olden_Era/',
    license: 'Steam Subscriber Agreement',
    retrievedAt: '2026-05-31',
  },
  {
    id: 'official-wiki-main-page',
    kind: 'official-wiki',
    title: 'Heroes of Might and Magic: Olden Era Official Wiki - Main Page',
    url: 'https://wiki.hoodedhorse.com/Heroes_of_Might_and_Magic_Olden_Era/Main_Page',
    license: 'CC-BY-SA-4.0',
    retrievedAt: '2026-05-31',
  },
  {
    id: 'official-wiki-factions',
    kind: 'official-wiki',
    title: 'Heroes of Might and Magic: Olden Era Official Wiki - Factions',
    url: 'https://wiki.hoodedhorse.com/Heroes_of_Might_and_Magic_Olden_Era/Factions',
    license: 'CC-BY-SA-4.0',
    retrievedAt: '2026-05-31',
  },
  {
    id: 'ubisoft-roadmap-2026-05-28',
    kind: 'ubisoft-news',
    title: 'Heroes of Might and Magic: Olden Era Early Access Roadmap',
    url: 'https://news.ubisoft.com/en-au/article/78nufFYRzpa1Vcp1Y8LnNF/heroes-of-might-and-magic-olden-era-early-access-roadmap',
    license: 'Ubisoft News Terms',
    retrievedAt: '2026-05-31',
  },
] satisfies WikiSource[]

export const sourceIds = new Set(wikiSources.map((source) => source.id))
```

- [ ] **Step 3: Add first-pass faction facts**

Write `apps/olden/src/data/olden/factions.ts`:

```ts
import type { Faction } from './schema'

const verification = {
  lastVerified: '2026-05-31',
  gameVersion: 'v0.80.16',
  sourceIds: ['official-wiki-main-page', 'official-wiki-factions'],
}

export const factions = [
  {
    id: 'temple',
    name: 'Temple',
    nativeTerrain: 'Grass',
    identity: 'Balanced human army that rewards buffs, positioning, and reliable fundamentals.',
    beginnerFit: 'easy',
    playstyleTags: ['balanced', 'buffs', 'durable army'],
    strengths: ['Straightforward army roles', 'Good learning faction', 'Strong positive effect synergies'],
    weaknesses: ['Can be outpaced by sharper faction mechanics', 'Needs clean tempo to convert durability into wins'],
    coreQuestions: [
      'Which buff carries this fight?',
      'Can the army preserve elite stacks through the first two weeks?',
    ],
    verification,
  },
  {
    id: 'necropolis',
    name: 'Necropolis',
    nativeTerrain: 'Deathland',
    identity: 'Undead attrition faction built around snowballing casualties into long-game pressure.',
    beginnerFit: 'medium',
    playstyleTags: ['undead', 'attrition', 'reanimation'],
    strengths: ['Strong snowball potential', 'Good attrition identity', 'Morale-neutral undead consistency'],
    weaknesses: ['Can fall behind if early fights are inefficient', 'Requires tracking casualty value'],
    coreQuestions: ['Which fights feed the army instead of draining it?', 'When does the snowball become decisive?'],
    verification,
  },
  {
    id: 'grove',
    name: 'Grove',
    nativeTerrain: 'Autumn',
    identity: 'Nature and fae faction focused on movement, growth, and forest tempo.',
    beginnerFit: 'medium',
    playstyleTags: ['nature', 'mobility', 'tempo'],
    strengths: ['Strong map-flow identity', 'Flexible creature roles', 'Good defensive terrain feel'],
    weaknesses: ['Can be punished when tempo tools are mistimed', 'Requires map awareness'],
    coreQuestions: [
      'Can movement advantages become resource advantages?',
      'Which fights are worth taking before growth spikes?',
    ],
    verification,
  },
  {
    id: 'dungeon',
    name: 'Dungeon',
    nativeTerrain: 'Dirt',
    identity: 'Dark elf and underground faction built around flexible attacks and tactical versatility.',
    beginnerFit: 'hard',
    playstyleTags: ['versatile', 'dark elves', 'dragons'],
    strengths: ['Flexible unit attack patterns', 'High tactical ceiling', 'Good outplay potential'],
    weaknesses: ['Demands matchup knowledge', 'Mispositioning wastes its flexibility'],
    coreQuestions: ['Which attack option denies the enemy response?', 'Can the hero and army force unfair trades?'],
    verification,
  },
  {
    id: 'hive',
    name: 'Hive',
    nativeTerrain: 'Lava',
    identity: 'Demonic insectoid swarm faction that rewards colony synergy and pressure.',
    beginnerFit: 'hard',
    playstyleTags: ['swarm', 'pressure', 'synergy'],
    strengths: [
      'Strong identity when armies stay synergistic',
      'Pressure-oriented game plan',
      'Distinct unit ecosystem',
    ],
    weaknesses: ['Punished by broken synergy', 'Requires knowing when to commit'],
    coreQuestions: [
      'Is the army still reinforcing the swarm plan?',
      'Can pressure land before scaling factions stabilize?',
    ],
    verification,
  },
  {
    id: 'schism',
    name: 'Schism',
    nativeTerrain: 'Snow',
    identity: 'Water-depth splinter faction that denies enemy abilities and controls battle flow.',
    beginnerFit: 'hard',
    playstyleTags: ['denial', 'summons', 'battlefield control'],
    strengths: ['Ability and spell denial', 'Strong control identity', 'Summoning pressure'],
    weaknesses: ['High decision burden', 'Weak sequencing loses its control edge'],
    coreQuestions: ['Which enemy action must be denied?', 'Can summons convert control into material advantage?'],
    verification,
  },
] satisfies Faction[]
```

- [ ] **Step 4: Add game modes and roadmap facts**

Write `apps/olden/src/data/olden/game-modes.ts` with entries for campaign, classic, single hero, arena, scenario, multiplayer, and map editor. Use `sourceIds: ['steam-store-3105440']`.

Write `apps/olden/src/data/olden/roadmap.ts` with the roadmap items from the Ubisoft source and `sourceIds: ['ubisoft-roadmap-2026-05-28']`.

- [ ] **Step 5: Run type-aware lint**

```bash
bun run --cwd apps/olden lint:oxlint:type
```

Expected: no missing type imports and no unused exports.

- [ ] **Step 6: Commit data contracts**

```bash
git add apps/olden/src/data/olden
git commit -m "feat(olden): add wiki data contracts"
```

## Task 3: Build Content Pages

**Files:**

- Create all MDX files listed under File Structure.
- Modify: `apps/olden/app/(home)/page.tsx`

- [ ] **Step 1: Create docs index**

Write `apps/olden/content/docs/index.mdx`:

```mdx
---
title: Olden Era Wiki
description: Unofficial player guide and reference for Heroes of Might and Magic: Olden Era.
---

# Olden Era Wiki

This is an unofficial player wiki for Heroes of Might and Magic: Olden Era. It focuses on practical play: what each faction does, how the map economy works, how combat decisions compound, and which source/version each fact came from.

Start here:

- [Getting started](/docs/getting-started)
- [First week checklist](/docs/getting-started/first-week)
- [Faction overview](/docs/factions)
- [Combat fundamentals](/docs/fundamentals/combat)
- [Reference index](/docs/reference)
- [Sources and freshness](/docs/meta/sources)
```

- [ ] **Step 2: Create beginner guide**

Write `apps/olden/content/docs/getting-started/index.mdx` with these sections:

```mdx
---
title: Getting Started
description: What to learn first when starting Heroes of Might and Magic: Olden Era.
---

# Getting Started

Olden Era is a turn-based strategy game about converting map movement into resources, resources into towns and armies, and armies into cleaner fights. New players should learn one faction, one map size, and one win condition before chasing perfect routes.

## First priorities

1. Pick Temple for the clearest first learning pass, or pick the faction whose fantasy keeps you engaged.
2. Spend early turns revealing resource piles, mines, creature dwellings, and safe fights.
3. Build economy and creature growth before spending everything on upgrades.
4. Keep elite stacks alive. Losing key stacks early usually costs more than skipping a risky fight.
5. Learn one combat idea at a time: initiative, retaliation, ranged pressure, spell timing, and blocking.

## Read next

- [First week checklist](/docs/getting-started/first-week)
- [Adventure map](/docs/fundamentals/adventure-map)
- [Economy](/docs/fundamentals/economy)
- [Combat](/docs/fundamentals/combat)
```

- [ ] **Step 3: Create fundamentals pages**

Create one MDX file for each fundamentals topic. Each page must include: concept, why it matters, beginner rule, advanced note, common mistake, sources.

Files:

```text
apps/olden/content/docs/fundamentals/adventure-map.mdx
apps/olden/content/docs/fundamentals/economy.mdx
apps/olden/content/docs/fundamentals/movement.mdx
apps/olden/content/docs/fundamentals/native-terrain.mdx
apps/olden/content/docs/fundamentals/towns.mdx
apps/olden/content/docs/fundamentals/heroes.mdx
apps/olden/content/docs/fundamentals/combat.mdx
apps/olden/content/docs/fundamentals/magic.mdx
apps/olden/content/docs/fundamentals/skills.mdx
apps/olden/content/docs/fundamentals/artifacts.mdx
apps/olden/content/docs/fundamentals/morale-luck-focus.mdx
```

Use this exact page skeleton for each topic and replace the body with topic-specific original prose:

```mdx
---
title: Combat
description: Core battle rules and tactical habits for Olden Era fights.
---

# Combat

## What it is

Combat converts your map decisions into permanent advantage or permanent losses. The goal is not only to win the current fight, but to preserve enough army to keep taking the next fights.

## Beginner rule

Take fights where your strongest stacks act before the enemy can punish them, and avoid fights that trade away rare or slow-growing units for common rewards.

## Advanced note

Initiative, retaliation, blocking, ranged lines, spell timing, and unit abilities matter more when both armies are close in power. Track which enemy stack can still act before committing fragile units.

## Common mistake

Autopiloting every neutral fight wastes elite stacks. Manual play is worth it when the reward unlocks a mine, dwelling, town timing, or hero level.

## Sources

- [Official wiki main page](https://wiki.hoodedhorse.com/Heroes_of_Might_and_Magic_Olden_Era/Main_Page)
- [Steam store page](https://store.steampowered.com/app/3105440/Heroes_of_Might_and_Magic_Olden_Era/)
```

- [ ] **Step 4: Create faction pages**

Create:

```text
apps/olden/content/docs/factions/index.mdx
apps/olden/content/docs/factions/temple.mdx
apps/olden/content/docs/factions/necropolis.mdx
apps/olden/content/docs/factions/grove.mdx
apps/olden/content/docs/factions/dungeon.mdx
apps/olden/content/docs/factions/hive.mdx
apps/olden/content/docs/factions/schism.mdx
```

Each faction page must include:

- identity in one paragraph;
- native terrain;
- beginner difficulty;
- strengths and weaknesses;
- first-week priorities;
- army preservation notes;
- laws/mechanics to inspect;
- hero questions;
- matchup/counter notes;
- source and freshness block.

- [ ] **Step 5: Create reference index pages**

Create:

```text
apps/olden/content/docs/reference/index.mdx
apps/olden/content/docs/reference/heroes.mdx
apps/olden/content/docs/reference/units.mdx
apps/olden/content/docs/reference/spells.mdx
apps/olden/content/docs/reference/skills.mdx
apps/olden/content/docs/reference/laws.mdx
apps/olden/content/docs/reference/artifacts.mdx
apps/olden/content/docs/reference/buildings.mdx
apps/olden/content/docs/reference/map-objects.mdx
```

Each page starts as a navigable reference with original explanation plus typed-table output. Full entry data can be expanded in later commits, but each page must already explain how players use that category.

- [ ] **Step 6: Create meta pages**

Write `apps/olden/content/docs/meta/legal.mdx` and `apps/olden/content/docs/meta/sources.mdx`.

`legal.mdx` must state:

```mdx
---
title: Legal and Attribution
description: Attribution, license, trademark, and asset policy for Olden Era Wiki.
---

# Legal and Attribution

Olden Era Wiki is an unofficial fan/player resource and is not affiliated with Ubisoft, Hooded Horse, or Unfrozen.

Heroes of Might and Magic: Olden Era names and marks belong to their respective owners.

Official wiki text and structured facts are used only where compatible with the official wiki's Creative Commons Attribution-ShareAlike notice, with attribution and source links. Strategy prose on this site is original unless a source is explicitly cited.

Game art, logos, screenshots, and videos are not redistributed by default. Pages link to official sources instead.
```

- [ ] **Step 7: Commit content baseline**

```bash
git add apps/olden/content apps/olden/app
git commit -m "docs(olden): add wiki content baseline"
```

## Task 4: Add Wiki Components

**Files:**

- Create: `apps/olden/src/components/wiki/source-note.tsx`
- Create: `apps/olden/src/components/wiki/faction-grid.tsx`
- Create: `apps/olden/src/components/wiki/reference-table.tsx`
- Create: `apps/olden/src/components/wiki/freshness-badge.tsx`
- Modify: `apps/olden/mdx-components.tsx`
- Modify: `apps/olden/app/(home)/page.tsx`

- [ ] **Step 1: Implement freshness badge**

Write `apps/olden/src/components/wiki/freshness-badge.tsx`:

```tsx
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
```

- [ ] **Step 2: Implement source note**

Write `apps/olden/src/components/wiki/source-note.tsx`:

```tsx
import { wikiSources } from '@/src/data/olden/sources'

type SourceNoteProps = {
  ids: string[]
}

export function SourceNote({ ids }: SourceNoteProps) {
  const sources = wikiSources.filter((source) => ids.includes(source.id))

  return (
    <aside className="not-prose rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">Sources</h2>
      <ul className="mt-2 space-y-2">
        {sources.map((source) => (
          <li key={source.id}>
            <a className="font-medium text-zinc-900 underline dark:text-zinc-100" href={source.url}>
              {source.title}
            </a>
            <span className="text-zinc-600 dark:text-zinc-400"> - retrieved {source.retrievedAt}</span>
          </li>
        ))}
      </ul>
    </aside>
  )
}
```

- [ ] **Step 3: Implement faction grid**

Write `apps/olden/src/components/wiki/faction-grid.tsx`:

```tsx
import Link from 'next/link'

import { factions } from '@/src/data/olden/factions'
import { FreshnessBadge } from './freshness-badge'

export function FactionGrid() {
  return (
    <div className="not-prose grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {factions.map((faction) => (
        <Link
          key={faction.id}
          className="rounded-lg border border-zinc-200 p-4 transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
          href={`/docs/factions/${faction.id}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">{faction.name}</h2>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{faction.nativeTerrain}</p>
            </div>
            <span className="rounded-md bg-zinc-100 px-2 py-1 text-xs font-medium capitalize text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              {faction.beginnerFit}
            </span>
          </div>
          <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">{faction.identity}</p>
          <div className="mt-4">
            <FreshnessBadge {...faction.verification} />
          </div>
        </Link>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Implement reference table**

Write a generic table that accepts rows and columns:

```tsx
type Column<T> = {
  key: string
  header: string
  render: (row: T) => React.ReactNode
}

type ReferenceTableProps<T> = {
  rows: T[]
  columns: Array<Column<T>>
}

export function ReferenceTable<T>({ rows, columns }: ReferenceTableProps<T>) {
  return (
    <div className="not-prose overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
        <thead className="bg-zinc-50 dark:bg-zinc-950">
          <tr>
            {columns.map((column) => (
              <th key={column.key} className="px-3 py-2 text-left font-semibold text-zinc-900 dark:text-zinc-100">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column) => (
                <td key={column.key} className="px-3 py-2 align-top text-zinc-700 dark:text-zinc-300">
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 5: Register components in MDX**

Modify `apps/olden/mdx-components.tsx`:

```tsx
import defaultMdxComponents from 'fumadocs-ui/mdx'
import type { MDXComponents } from 'mdx/types'
import { FactionGrid } from '@/src/components/wiki/faction-grid'
import { FreshnessBadge } from '@/src/components/wiki/freshness-badge'
import { SourceNote } from '@/src/components/wiki/source-note'

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    FactionGrid,
    FreshnessBadge,
    SourceNote,
    ...components,
  }
}
```

- [ ] **Step 6: Commit components**

```bash
git add apps/olden/src/components apps/olden/mdx-components.tsx apps/olden/app
git commit -m "feat(olden): add wiki reference components"
```

## Task 5: Add Integrity Tests

**Files:**

- Create: `apps/olden/src/components/wiki/__tests__/content-integrity.test.ts`

- [ ] **Step 1: Write source coverage tests**

Write:

```ts
import { describe, expect, it } from 'bun:test'

import { factions } from '@/src/data/olden/factions'
import { sourceIds, wikiSources } from '@/src/data/olden/sources'

describe('Olden Era wiki data', () => {
  it('registers exactly the six Early Access factions', () => {
    expect(factions.map((faction) => faction.id).sort()).toEqual([
      'dungeon',
      'grove',
      'hive',
      'necropolis',
      'schism',
      'temple',
    ])
  })

  it('uses valid source ids for every faction', () => {
    for (const faction of factions) {
      expect(faction.verification.sourceIds.length).toBeGreaterThan(0)
      for (const sourceId of faction.verification.sourceIds) {
        expect(sourceIds.has(sourceId)).toBe(true)
      }
    }
  })

  it('records retrieval dates and URLs for every source', () => {
    for (const source of wikiSources) {
      expect(source.url).toMatch(/^https:\/\//)
      expect(source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
```

- [ ] **Step 2: Write MDX hygiene test**

Extend the same test file:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const contentRoot = join(import.meta.dir, '../../../../content/docs')

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

describe('Olden Era MDX content', () => {
  it('has title and description frontmatter on every page', () => {
    for (const path of walk(contentRoot).filter((candidate) => candidate.endsWith('.mdx'))) {
      const content = readFileSync(path, 'utf8')
      expect(content).toMatch(/^---\ntitle: .+\ndescription: .+\n---/m)
    }
  })

  it('does not ship planning scaffolding markers', () => {
    const disallowedMarkers = ['TO' + 'DO', 'TB' + 'D']
    for (const path of walk(contentRoot).filter((candidate) => candidate.endsWith('.mdx'))) {
      const content = readFileSync(path, 'utf8')
      for (const marker of disallowedMarkers) {
        expect(content.includes(marker)).toBe(false)
      }
    }
  })
})
```

- [ ] **Step 3: Run tests**

```bash
bun run test:olden
```

Expected: all tests pass.

- [ ] **Step 4: Commit tests**

```bash
git add apps/olden/src/components/wiki/__tests__/content-integrity.test.ts
git commit -m "test(olden): guard wiki content integrity"
```

## Task 6: Add Docker Build and Deploy Scripts

**Files:**

- Create: `apps/olden/Dockerfile`
- Create: `packages/scripts/src/olden/build-image.ts`
- Create: `packages/scripts/src/olden/deploy-service.ts`

- [ ] **Step 1: Add Dockerfile**

Create `apps/olden/Dockerfile` by adapting `apps/docs/Dockerfile` and replacing `docs` with `olden`. The final runner stage must use:

```dockerfile
WORKDIR /app/apps/olden
CMD ["node", "server.js"]
```

The builder stage must run:

```dockerfile
RUN bun run --filter olden build
```

- [ ] **Step 2: Add build script**

Create `packages/scripts/src/olden/build-image.ts` from the docs build script with these names:

```ts
const registry = options.registry ?? process.env.OLDEN_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
const repository = options.repository ?? process.env.OLDEN_IMAGE_REPOSITORY ?? 'lab/olden'
const tag = options.tag ?? process.env.OLDEN_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
const dockerfile = resolve(repoRoot, options.dockerfile ?? process.env.OLDEN_DOCKERFILE ?? 'apps/olden/Dockerfile')
const cacheRef = options.cacheRef ?? process.env.OLDEN_BUILD_CACHE_REF ?? `${registry}/${repository}:buildcache`
```

- [ ] **Step 3: Add deploy script**

Create `packages/scripts/src/olden/deploy-service.ts` from `packages/scripts/src/docs/deploy-service.ts` with:

```ts
const registry = process.env.OLDEN_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
const repository = process.env.OLDEN_IMAGE_REPOSITORY ?? 'lab/olden'
const kustomizePath = resolve(repoRoot, process.env.OLDEN_KUSTOMIZE_PATH ?? 'argocd/applications/olden')
const deploymentName = process.env.OLDEN_K8S_DEPLOYMENT ?? 'olden'
```

The manifest update regex must target `registry.ide-newton.ts.net/lab/olden`.

- [ ] **Step 4: Run script tests by executing dry build metadata path**

```bash
bun run --filter @proompteng/scripts lint:oxlint:type -- packages/scripts/src/olden
```

If the scripts package does not expose that scoped command, run:

```bash
bun run --cwd packages/scripts lint:oxlint:type
```

Expected: no type-aware lint failures from the new olden scripts.

- [ ] **Step 5: Commit build scripts**

```bash
git add apps/olden/Dockerfile packages/scripts/src/olden package.json
git commit -m "build(olden): add image build and deploy tooling"
```

## Task 7: Add Argo CD Manifests and Image Automation

**Files:**

- Create: `argocd/applications/olden/deployment.yaml`
- Create: `argocd/applications/olden/service.yaml`
- Create: `argocd/applications/olden/kustomization.yaml`
- Modify: `argocd/applications/cloudflare/configmap.yaml`
- Modify: `argocd/applicationsets/product.yaml`
- Modify: `argocd/applications/argocd/base/image-updater-product.yaml`
- Modify: `.github/workflows/docker-build-push.yaml`
- Modify: `.github/workflows/pull-request.yml`
- Modify: `.github/workflows/release-pr-automerge.yml`

- [ ] **Step 1: Create deployment**

Write `argocd/applications/olden/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: olden
  namespace: olden
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
      maxUnavailable: 1
  selector:
    matchLabels:
      app: olden
  template:
    metadata:
      labels:
        app: olden
    spec:
      nodeSelector:
        kubernetes.io/arch: arm64
      containers:
        - name: olden
          image: registry.ide-newton.ts.net/lab/olden
          resources:
            limits:
              cpu: '1'
              memory: '512Mi'
            requests:
              cpu: '100m'
              memory: '256Mi'
          ports:
            - containerPort: 3000
          readinessProbe:
            httpGet:
              path: /
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
```

- [ ] **Step 2: Create service**

Write `argocd/applications/olden/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: olden
  namespace: olden
spec:
  selector:
    app: olden
  ports:
    - port: 80
      targetPort: 3000
```

- [ ] **Step 3: Add explicit Cloudflare Tunnel route**

Modify `argocd/applications/cloudflare/configmap.yaml` so the `olden.proompteng.ai` route appears before the wildcard fallback:

```yaml
- hostname: olden.proompteng.ai
  service: http://olden.olden.svc.cluster.local:80
```

- [ ] **Step 4: Create kustomization**

Write `argocd/applications/olden/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
images:
  - name: registry.ide-newton.ts.net/lab/olden
    newTag: '0.0.0'
    newName: registry.ide-newton.ts.net/lab/olden
```

- [ ] **Step 5: Add Product ApplicationSet entry**

Add this element near the public product apps in `argocd/applicationsets/product.yaml`:

```yaml
- name: olden
  path: argocd/applications/olden
  namespace: olden
  renderWithLovely: false
  annotations:
    argocd.argoproj.io/sync-wave: '5'
  automation: auto
  enabled: 'true'
```

Do not create a `Namespace` manifest under `argocd/applications/olden`.

- [ ] **Step 6: Add Argo CD Image Updater registration**

Add `olden` to `argocd/applications/argocd/base/image-updater-product.yaml`:

```yaml
- namePattern: olden
  writeBackConfig:
    method: git:secret:argocd/image-updater-git-ssh
    gitConfig:
      repository: git@github.com:proompteng/lab.git
      branch: main:release/{{.SHA256}}
      writeBackTarget: kustomization:/argocd/applications/olden
  images:
    - alias: olden
      imageName: registry.ide-newton.ts.net/lab/olden:0.x
      manifestTargets:
        kustomize:
          name: registry.ide-newton.ts.net/lab/olden
```

Expected: Image Updater watches semver `0.x` image tags and writes only `argocd/applications/olden/kustomization.yaml` to `release/<sha256>` branches.

- [ ] **Step 7: Add GitHub Actions release path**

Modify `.github/workflows/docker-build-push.yaml` so `apps/olden/**` and `packages/design/**` publish `registry.ide-newton.ts.net/lab/olden` through `docker-build-common.yaml`.

Modify `.github/workflows/pull-request.yml` so Olden PRs run:

```bash
bun run --filter olden test
bun run --filter olden build
```

Modify `.github/workflows/release-pr-automerge.yml` so Image Updater PRs changing only `argocd/applications/olden/kustomization.yaml` are eligible for squash automerge.

Expected: merge to `main` builds a semver image, Image Updater promotes the Kustomize tag on a release branch, `auto-pr-release-branches.yml` opens the release PR, and `release-pr-automerge.yml` enables squash automerge.

- [ ] **Step 8: Validate rendered manifests**

```bash
kubectl kustomize argocd/applications/olden
kubectl kustomize argocd/applications/cloudflare
bun run lint:argocd
```

Expected: olden deployment and service render; no kubeconform failures for the new app. The Cloudflare app renders a config entry for `olden.proompteng.ai`, and the Image Updater config contains the `olden` application reference.

- [ ] **Step 9: Commit manifests and automation**

```bash
git add argocd/applications/olden argocd/applications/cloudflare/configmap.yaml argocd/applicationsets/product.yaml argocd/applications/argocd/base/image-updater-product.yaml .github/workflows/docker-build-push.yaml .github/workflows/pull-request.yml .github/workflows/release-pr-automerge.yml
git commit -m "deploy(olden): add GitOps release automation"
```

## Task 8: Local Verification

**Files:**

- No new files unless verification exposes defects.

- [ ] **Step 1: Run focused tests and lint**

```bash
bun run test:olden
bun run lint:olden
bun run --cwd apps/olden lint:oxlint:type
bun run build:olden
```

Expected: all commands pass.

- [ ] **Step 2: Run local server**

```bash
bun run --filter olden dev
```

Open `http://127.0.0.1:3000` or the next available port shown by Next.

Verify:

- home page loads;
- `/docs` loads;
- `/docs/factions` loads;
- `/docs/factions/temple` loads;
- search opens and finds `Temple`, `combat`, and `source`;
- dark/light theme toggle works;
- mobile viewport has no horizontal overflow.

- [ ] **Step 3: Build production container**

```bash
docker buildx build --platform linux/arm64 -f apps/olden/Dockerfile -t registry.ide-newton.ts.net/lab/olden:local-olden .
```

Expected: standalone Next image builds.

- [ ] **Step 4: Commit verification fixes**

If fixes were needed:

```bash
git add apps/olden packages/scripts/src/olden argocd/applications/olden
git commit -m "fix(olden): resolve verification findings"
```

## Task 9: Autorelease and Autodeploy Through GitOps

**Files:**

- Modify: `argocd/applications/olden/kustomization.yaml` through Argo CD Image Updater release automation.

- [ ] **Step 1: Merge app changes to main**

After CI is green and the PR is approved, squash-merge the application PR. Do not manually patch live manifests for normal rollout.

Expected: the push to `main` triggers `.github/workflows/docker-build-push.yaml`.

- [ ] **Step 2: Verify GitHub Actions image publish**

```bash
gh run list -R proompteng/lab --workflow docker-build-push.yaml --limit 5
gh run watch <run-id> -R proompteng/lab
```

Expected: `build-olden` succeeds and publishes `registry.ide-newton.ts.net/lab/olden:<semver>`.

- [ ] **Step 3: Verify Image Updater release branch**

Image Updater writes `argocd/applications/olden/kustomization.yaml` to a branch named `release/<sha256>`. The push triggers `.github/workflows/auto-pr-release-branches.yml`.

```bash
gh pr list -R proompteng/lab --head 'release/*' --state open --json number,title,headRefName
```

Expected: a release PR exists for the Olden image promotion.

- [ ] **Step 4: Verify autorelease PR automerge**

```bash
gh pr view <release-pr> -R proompteng/lab --json autoMergeRequest,files,headRefName,baseRefName
gh pr checks <release-pr> -R proompteng/lab --watch
```

Expected: the PR changes only `argocd/applications/olden/kustomization.yaml`, auto-merge is enabled, required checks pass, and GitHub squash-merges it.

- [ ] **Step 5: Wait for Argo**

```bash
argocd app get olden
argocd app wait olden --sync --health --timeout 600
```

If the Argo application name includes the cluster suffix, run:

```bash
argocd app list | rg olden
```

Use the exact app name returned by Argo.

Expected: Argo syncs the promoted Kustomize tag, rolls the `olden` deployment, and the Cloudflare tunnel route serves the in-cluster service.

- [ ] **Step 6: Manual fallback only for explicit emergency**

The scripts under `packages/scripts/src/olden` remain available for explicit operator use, but the normal production path is:

```bash
main merge -> Docker image publish -> Argo CD Image Updater release branch -> release PR -> autorelease merge -> Argo CD sync
```

## Task 10: Live Verification

**Files:**

- Create: `docs/olden/live-verification-2026-05-31.md`

- [ ] **Step 1: Verify DNS and HTTP**

```bash
dig +short olden.proompteng.ai
curl -fsSI https://olden.proompteng.ai/
curl -fsS https://olden.proompteng.ai/docs | head
curl -fsS https://olden.proompteng.ai/llms-full.txt | head -40
```

Expected:

- DNS returns an address or CNAME that routes to the cluster ingress;
- `/` returns HTTP 200;
- `/docs` returns HTML with Olden Era page content;
- `/llms-full.txt` includes wiki page text.

- [ ] **Step 2: Verify Kubernetes state**

```bash
kubectl -n olden get deployment olden
kubectl -n olden rollout status deployment/olden
kubectl -n olden get pods -l app=olden -o wide
kubectl -n olden logs deployment/olden --tail=100
```

Expected: deployment available, pods ready, no repeated runtime errors.

- [ ] **Step 3: Verify public content paths**

```bash
for path in / /docs /docs/getting-started /docs/factions /docs/factions/temple /docs/reference /docs/meta/legal /docs/meta/sources; do
  curl -fsSI "https://olden.proompteng.ai${path}" | head -1
done
```

Expected: every route returns `HTTP/2 200` or `HTTP/1.1 200`.

- [ ] **Step 4: Save verification report**

Write `docs/olden/live-verification-2026-05-31.md` with:

```md
# Olden Era Wiki Live Verification - 2026-05-31

## Build

- Image:
- Commit:
- Argo application:

## Checks

- DNS:
- Root route:
- Docs route:
- Faction route:
- Source/legal route:
- Kubernetes rollout:
- Pod logs:

## Result

`https://olden.proompteng.ai` is live and serving the Olden Era Wiki.
```

Fill every bullet with command output summaries from the same verification run.

- [ ] **Step 5: Commit verification report**

```bash
git add docs/olden/live-verification-2026-05-31.md
git commit -m "docs(olden): record live verification"
```

## Task 11: Maintenance and Freshness

**Files:**

- Create: `apps/olden/content/docs/meta/changelog.mdx`
- Create: `docs/olden/content-refresh-runbook.md`

- [ ] **Step 1: Add changelog page**

Write `apps/olden/content/docs/meta/changelog.mdx`:

```mdx
---
title: Wiki Changelog
description: Changes to Olden Era Wiki content and source verification.
---

# Wiki Changelog

## 2026-05-31

- Launched first wiki structure for getting started, fundamentals, factions, reference, strategy, and source policy.
- Verified baseline against the Steam store page, official Hooded Horse wiki, and Ubisoft Early Access roadmap.
```

- [ ] **Step 2: Add refresh runbook**

Write `docs/olden/content-refresh-runbook.md`:

````md
# Olden Era Wiki Content Refresh Runbook

## Frequency

- Check official wiki and Steam news after every game patch.
- Check Ubisoft/Hooded Horse news weekly while the game is in Early Access.
- Re-run content integrity tests after every content change.

## Commands

```bash
bun run test:olden
bun run lint:olden
bun run build:olden
```
````

## Manual checks

- Confirm the latest client patch shown on the official wiki.
- Confirm faction names and game modes still match the current game.
- Confirm roadmap pages distinguish released features from planned features.
- Confirm all copied facts have attribution and license coverage.
- Confirm strategy prose is original and does not copy other guides.

## Release

- Use Conventional Commits.
- Open PR with content sources listed.
- Wait for Olden PR CI before merge.
- Let the normal release path run after merge: Docker image publish, Argo CD Image Updater release branch, release PR automerge, and Argo CD sync.
- Verify `https://olden.proompteng.ai/docs/meta/sources` after the release PR merges and Argo reports the app healthy.

````

- [ ] **Step 3: Commit maintenance docs**

```bash
git add apps/olden/content/docs/meta/changelog.mdx docs/olden/content-refresh-runbook.md
git commit -m "docs(olden): add freshness runbook"
````

## Final Verification Checklist

- [ ] `bun run test:olden` passes.
- [ ] `bun run lint:olden` passes.
- [ ] `bun run --cwd apps/olden lint:oxlint:type` passes.
- [ ] `bun run build:olden` passes.
- [ ] `docker buildx build --platform linux/arm64 -f apps/olden/Dockerfile ...` passes.
- [ ] `kubectl kustomize argocd/applications/olden` renders deployment and service.
- [ ] `kubectl kustomize argocd/applications/cloudflare` renders an explicit `olden.proompteng.ai` tunnel ingress route.
- [ ] `bun run lint:argocd` passes.
- [ ] Browser verification covers desktop and mobile widths.
- [ ] `https://olden.proompteng.ai/` returns 200.
- [ ] `https://olden.proompteng.ai/docs/factions/temple` returns 200.
- [ ] `https://olden.proompteng.ai/docs/meta/legal` returns 200.
- [ ] `https://olden.proompteng.ai/llms-full.txt` returns content.
- [ ] Argo CD app is Synced and Healthy.
- [ ] Live Kubernetes deployment in namespace `olden` is available.
- [ ] The site labels itself as unofficial.
- [ ] Every factual page includes sources and freshness.
- [ ] No official art is redistributed without recorded permission.

## Implementation Handoff

Use this design document as the source of truth for implementing `olden.proompteng.ai`. Execute tasks in order unless a later task reveals a required correction to the app structure, content policy, or GitOps rollout path.
