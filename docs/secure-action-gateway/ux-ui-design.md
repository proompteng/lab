# Secure Action Gateway UI Design

The UI should feel closer to Datadog logs or Vercel runtime logs than a generated workflow dashboard. The main object is the event stream.

## Principles

- Dark, quiet, minimal.
- No decorative colors.
- No marketing copy.
- No instructional paragraphs inside the product.
- Dense tables, clear status badges, stable spacing.
- AgentRun manifest and event evidence visible beside the event list.
- Every label should map to a real primitive: AgentRun, Event, Rule, Approval, Connector.

## Root Page

Root page layout:

- top nav with product name, route links, event count, blocked count, JSONL export;
- main event list with columns `Time`, `Source`, `Result`, `Operation`, `Policy`;
- right panel with AgentRuns and selected manifest/evidence.

The root page must not be a request form. It must show the current security state of internal agents.

## Routes

- `/`: event log plus AgentRun detail.
- `/events`: searchable event table.
- `/rules`: natural-language rule creation and rule list.
- `/agents`: evaluated AgentRuns and redacted manifest view.
- `/connectors`: bounded connector inventory.
- `/approvals`: pending and decided approvals.

## Visual Language

- Background: zinc/black.
- Borders: zinc only.
- Status badges: restrained monochrome variants.
- Icons: small lucide icons only where useful.
- Controls: Base UI primitives composed with Tailwind.

## Required Empty States

Empty states should be short:

- `No events.`
- `No AgentRuns evaluated.`
- `No approvals.`

No empty-state marketing text.

## Walkthrough Copy

Use these phrases in the recording:

- "SAG is the action gate for internal AgentRuns."
- "The product starts with events because auditability is the point."
- "The AgentRun requested sensitive secret authority, so SAG blocked it before execution."
- "Natural language creates an inspectable deterministic rule."
- "Approval is permission checked and every decision is logged."
