# Database Migrations

> **Important:** The LoopTroop app database schema is bootstrapped at runtime by `server/db/init.ts`. Runtime startup, not this migration directory, is the source of truth for creating and evolving the app database.

## App DB workflow

Do not use `drizzle-kit push`, `drizzle-kit migrate`, `npm run db:push`, or `npm run db:push:app` as the normal app schema-change workflow. They are retained only for ad-hoc local experiments or external tooling checks.

For app schema changes:

- Schema changes should be made in `server/db/schema.ts`.
- Runtime bootstrap/evolution changes should be made in `server/db/init.ts`.
- If you need to regenerate migration artifacts for external tooling, use:
  ```bash
  npm run db:generate:app
  ```
  Then verify the output against `schema.ts` before committing.

If you invoke Drizzle Kit directly, pass the config explicitly from the repository root, for example:

```bash
npx drizzle-kit check --config=server/db/app.config.ts
npx drizzle-kit check --config=server/db/project.config.ts
```
