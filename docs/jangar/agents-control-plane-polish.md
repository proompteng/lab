# Agents control-plane UI polish (design)

## Summary

This document proposes a focused UX and UI polish pass for the Agents control-plane surfaces in Jangar, specifically
navigation, empty states, detail pages, tables/lists, and status badges. The goal is to improve clarity, reduce
cognitive load, and standardize visual and interaction patterns without re-architecting the control-plane.

## Goals

- Make navigation and location awareness obvious across all control-plane routes.
- Standardize empty/loading/error states with clear next actions.
- Improve detail pages so the most important status and actions are visible above the fold.
- Normalize list and table patterns for faster scanning and consistent interaction.
- Unify status badge semantics so states are readable and comparable across views.
- Strengthen accessibility (keyboard, focus, contrast, semantic structure).
- Ship changes incrementally with low regression risk and measurable impact.

## Non-goals

- Redesigning the entire information architecture or routing scheme.
- Introducing new control-plane primitives or changing API contracts.
- Replacing the existing component system or design tokens.
- Adding net-new complex workflows (this is polish, not expansion).

## UX principles

- Navigation should answer “Where am I?” and “How do I get back?” within one glance.
- Keep the primary call-to-action above the fold and reduce competing actions.
- Prefer progressive disclosure over long, dense pages; collapse what is secondary.
- Make empty states helpful: explain why it’s empty and what to do next.
- Keep status meaning consistent everywhere (text + color + icon + timing).
- Optimize for scanning: summary first, then details, then raw payloads.
- Avoid hidden complexity: if something is loading, be explicit about it.
- Honor user preferences (reduced motion, high-contrast settings) across all polish updates.

## Scope and UX updates

### Navigation

- Add a consistent control-plane page header with title, subtitle, scoped breadcrumbs, and primary actions.
- Make breadcrumb labels reflect resource names and resource types (not internal IDs only).
- Add a lightweight “scope switch” affordance (e.g., org/project or namespace) if multiple contexts exist.
- Provide a consistent “back to list” affordance in detail pages without relying on browser back.
- Persist the current namespace/scope in navigation links to avoid accidental context loss.

### Empty states

- Standardize empty states into a shared component with:
  - title + short explanation
  - primary action (create, connect, or refresh)
  - secondary help link (docs or example)
  - optional sample row or example configuration
- Distinguish between empty (no data), filtered (no match), and error states.
- Use the same empty-state pattern in lists, tabs, conditions/events, and logs.

### Detail pages

- Above the fold: status badge, name, resource type, last updated, and primary action.
- Group content by user tasks (Overview, Activity, Config, Permissions, Raw).
- Keep raw YAML/JSON in a dedicated, collapsible section with copy support.
- Ensure quick access to run history, recent events, and failure context.

### Tables and lists

- Define a unified list/table component that supports:
  - column definition and consistent alignment
  - density modes (compact/cozy)
  - sticky headers for long lists
  - row-level actions via kebab menus
  - consistent empty/loading/filtered states
- Present the most decision-making columns first (status, last updated, owner, failure reason).
- Use pagination or virtualized lists when data volume exceeds readable thresholds.

### Status badges

- Normalize a small, shared set of state categories (e.g., success, warning, danger, muted, pending).
- Always include text labels and optional icons; never rely on color alone.
- Provide deterministic mappings from backend status fields to UI labels.
- Support size variants for list rows vs. detail headers.

## Component inventory (proposed)

### Navigation

- ControlPlaneHeader
  - title, subtitle, breadcrumbs, actions, meta (counts/last updated)
- ControlPlaneSidebarGroup
  - label, items, badge counts, collapsed state
- ScopedBreadcrumb
  - resource type + resource name + parent lineage

### Empty and loading states

- EmptyState
  - title, description, icon, primary action, secondary action, variant
- LoadingState
  - skeleton layout aligned with list/detail structure
- ErrorState
  - error summary, retry action, support link

### Detail pages

- DetailPageShell
  - header slots + tabs + secondary action rail
- DetailSummaryGrid
  - label/value with optional help text
- DetailSection
  - titled sections with consistent spacing and anchors
- RawPayloadPanel
  - JSON/YAML viewer with copy and download

### Tables and lists

- ControlPlaneList
  - supports cards and table variants with shared column defs
- ControlPlaneTable
  - columns, rows, sorting, density, empty/loading states
- RowActionsMenu
  - consistent action grouping and confirmation patterns

### Status and signals

- StatusBadge
  - label, tone, size, icon
- HealthIndicator
  - signal aggregation (e.g., conditions/events) with short tooltip

## Accessibility

- Ensure all navigation controls are keyboard reachable with visible focus states.
- Provide a skip-to-content link on control-plane routes.
- Use semantic landmarks (`nav`, `main`, `section`) and logical heading levels.
- Tables must have headers, captions, and announce sort order changes.
- Empty states must include readable headings and descriptions for screen readers.
- Status badges must include text labels and meet WCAG AA contrast requirements.
- Do not use color alone to convey state; ensure icon and label redundancy.

## Metrics and success criteria

- Reduced time-to-triage for failed runs (baseline vs. after).
- Lower UI-related support tickets for navigation/visibility issues.
- Improved accessibility audit scores (0 critical violations).
- Fewer click steps to reach common actions (create, view logs, view events).
- No regression in page performance (LCP/CLS within existing budgets).

## Rollout plan

### Phase 0: Baseline and audit

- Inventory current routes and component usage.
- Capture baseline metrics and accessibility audit.
- Define guardrails (performance, a11y, regression checklists).

### Phase 1: Quick wins

- Standardize typography, spacing, and button treatments.
- Add consistent empty/loading states to the highest-traffic pages.
- Improve status badge readability and label consistency.

### Phase 2: Component refinement

- Introduce shared header, list, and detail page shells.
- Migrate the highest-traffic routes to the new components.
- Document updated component usage.

### Phase 3: Motion and micro-UX

- Add purposeful transitions for navigation and list state changes.
- Ensure motion is minimal and respects reduced-motion preferences.

### Phase 4: Accessibility and performance verification

- Run keyboard, focus, and contrast audits.
- Verify LCP/CLS and fix regressions.

### Phase 5: GA and cleanup

- Remove feature flags, finalize docs, and backfill tests.

## Risks and mitigations

- Visual regressions: use snapshot coverage and a route-by-route QA checklist.
- Component drift: centralize changes in shared components.
- Performance regressions: budget animations and monitor LCP/CLS.
- Accessibility regressions: run audits per phase, not at the end.
- Scope creep: keep this effort to polish, not new UX flows.

## Open questions

- Which control-plane routes have the highest operator traffic today?
- What are the current performance budgets for the control-plane UI?
- Are there known status labels that must remain immutable for users?
- Do we need org/project scoping in navigation in the near term?
