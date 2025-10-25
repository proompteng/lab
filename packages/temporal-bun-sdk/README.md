```

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm --filter @proompteng/temporal-bun-sdk dev` | Watch `src/bin/start-worker.ts` with Bun. |
| `pnpm --filter @proompteng/temporal-bun-sdk build` | Type-check and emit to `dist/`. |
| `pnpm --filter @proompteng/temporal-bun-sdk test` | Run Bun tests under `tests/`. |
| `pnpm --filter @proompteng/temporal-bun-sdk run test:coverage` | Run tests with Bun coverage output under `.coverage/`. |
| `pnpm --filter @proompteng/temporal-bun-sdk run start:worker` | Launch the compiled worker. |
| `pnpm --filter @proompteng/temporal-bun-sdk run build:native` | Build the Bun ↔ Temporal native bridge. |
