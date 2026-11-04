# Database Migrations

> **Important:** Both database schemas are created at runtime, by `server/db/init.ts` (app database) and `server/db/project.ts` (project database). Runtime startup, not this migration directory, is the source of truth.

## App DB workflow

Do not use `drizzle-kit push`, `drizzle-kit migrate`, `npm run db:push`, or `npm run db:push:app` as the normal app schema-change workflow. They are retained only for ad-hoc local experiments or external tooling checks.

For schema changes:

- Schema changes should be made in `server/db/schema.ts`.
- Change the `CREATE TABLE` statements in `server/db/init.ts` (app database) or `server/db/project.ts` (project database) to match. They are the whole schema: nothing adds columns to an existing database.
- Bump `APP_SCHEMA_VERSION` or `PROJECT_SCHEMA_VERSION` in `server/db/schemaVersion.ts`. LoopTroop is in alpha and does not upgrade data, so a database written with any other version is refused at startup with instructions to start fresh.
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
