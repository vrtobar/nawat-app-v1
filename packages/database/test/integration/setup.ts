import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client';
import {
  assertSafeTestDatabase,
  REQUIRED_TEST_DATABASE,
  TEST_DATABASE_URL,
} from '../../src/testing';

// Thin local wiring. The target assertion and the connection string live in
// src/testing so that apps/api's integration suite uses the same definitions —
// there must be exactly one answer to "which database may be truncated".

export function createTestClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL });
  return new PrismaClient({ adapter });
}

export async function assertSafeTarget(prisma: PrismaClient): Promise<void> {
  await assertSafeTestDatabase(prisma);
}

export { REQUIRED_TEST_DATABASE as REQUIRED_DATABASE, TEST_DATABASE_URL };
