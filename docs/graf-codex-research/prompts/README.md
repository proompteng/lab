# Graf Codex research prompt catalog

This directory stores the NVIDIA Graf research prompt catalog referenced by `packages/scripts/src/graf/run-prompts.ts`. The catalog ensures each stream (foundries, ODM/EMS, logistics/ports, research partners, financing/risk, instrumentation vendors) has structured metadata, scoring heuristics, and citation guidance.

## Layout

- `prompt-schema.json`: JSON Schema describing every property a prompt definition must expose.
- `catalog.json`: Index of the active prompt files, catalog metadata (version, schema), and stream-level routing hints.
- `*.json`: One prompt definition per stream. Promote the schema before editing by running the validation commands below.

## Editing workflow

1. Update the stream-specific JSON file (e.g., `foundries.json`) with the required fields: `promptId`, `streamId`, `objective`, `inputs`, `expectedJsonEnvelope`, `scoringHeuristics`, and `citationPolicy`.
2. Run `pnpm exec biome check packages/scripts/src/graf` and `bun test packages/scripts/src/graf/**/__tests__/*.test.ts` to confirm the shared TypeScript schema still parses the updated structure.
3. If the schema changes, update `prompt-schema.json` and the TypeScript `zod` schema (`packages/scripts/src/graf/schema.ts`), then rerun Biome and the tests.
4. Add or refresh the corresponding entry in `catalog.json` (include `promptId`, `streamId`, `file`, `priority`, `cadence`, and any metadata your workflows need).
5. Reference the updated prompts in `docs/graf-codex-research.md` so Temporal/Argo operators know how to interpret the new fields.

## Validation

- `pnpm exec biome check packages/scripts/src/graf`
- `bun test packages/scripts/src/graf/**/__tests__/*.test.ts`
- `bun packages/scripts/src/graf/run-prompts.ts --dry-run` (ensures the driver can read every prompt and report what would be sent)

Run these commands from the repository root whenever you modify the catalog or driver logic.
