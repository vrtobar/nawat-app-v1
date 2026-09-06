import 'dotenv/config';

import { defineConfig } from 'prisma/config';

import { buildDatabaseUrl } from './src/url';

// Used by the Prisma CLI only (migrate, studio, db seed) — application code
// never reads this file, it connects via the driver adapter in src/index.ts.
//
// buildDatabaseUrl(), not process.env.DATABASE_URL directly. The CLI runs in
// both deployment shapes and only one of them sets DATABASE_URL: the migration
// ECS task receives DB_HOST/DB_PORT/DB_NAME as environment variables and
// DB_USERNAME/DB_PASSWORD from Secrets Manager, and assembles the rest. Reading
// DATABASE_URL alone worked locally and failed in ECS with "The datasource.url
// property is required in your Prisma config file", which names the config
// rather than the missing variable.
//
// Note it is called here rather than passed as a getter — the value is
// resolved once at config load, which is also why this must not throw when
// nothing is set. buildDatabaseUrl returns undefined instead, so commands that
// need no database (prisma generate) still run. Prisma's env() helper throws in
// that case, which is why it is not used.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: buildDatabaseUrl(),
  },
});
