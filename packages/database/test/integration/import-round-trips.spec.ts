import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { importFile } from '../../prisma/import-core';
import { PrismaClient } from '../../src/generated/prisma/client';
import { createTestClient, TEST_DATABASE_URL } from './setup';

// The regression guard for the defect that made this suite worth building.
//
// Import once upserted every entry and every translation individually inside
// one interactive transaction: 91 round trips for a 42-entry file. That fits
// comfortably inside Prisma's default 5000 ms on a local socket and died at
// 6201 ms through a bastion tunnel with P2028. The bug was invisible locally
// because local has no latency to expose it.
//
// SO THIS ASSERTS COUNT, NOT DURATION. A timing test cannot reproduce the
// failure in this environment at any threshold — round trips are sub-millisecond
// here against ~60 ms through a tunnel — and would only be flaky if it tried.
// The defect was never really "too slow"; it was "work proportional to rows",
// which is exactly measurable and fails deterministically the moment a per-row
// await comes back.

const workDir = mkdtempSync(join(tmpdir(), 'nawat-roundtrips-'));
const prisma: PrismaClient = createTestClient();

// Establishes its own preconditions rather than inheriting whatever the last
// file left behind. One of the round-trip tests deletes every dialect to prove
// the import refuses without them, and a suite whose files depend on each
// other's leftovers fails in an order nobody chose.
beforeAll(() => {
  execFileSync('npx', ['tsx', 'prisma/seed.ts'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('import cost scales with chunks, not rows', () => {
  it('issues far fewer write statements than there are rows', async () => {
    const dialect = await prisma.dialect.findFirstOrThrow({ select: { code: true } });

    // Deliberately larger than the seed fixture so a per-row implementation is
    // unmistakable: 300 entries with a translation each is 600 rows, which the
    // old shape would have turned into 600+ statements.
    const entries = Array.from({ length: 300 }, (_, i) => ({
      nawatContent: `probe-${i}`,
      type: 'WORD' as const,
      isPublished: true,
      translations: [{ dialectCode: dialect.code, contentEs: `sonda ${i}`, isPublished: true }],
    }));

    const file = join(workDir, 'counted.json');
    writeFileSync(
      file,
      JSON.stringify({
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        source: { database: 'nahuat_test', host: 'localhost' },
        counts: { entries: entries.length, translations: entries.length },
        entries,
      }),
    );

    // Counted through Prisma's query event rather than pg_stat_statements: no
    // extension needed, and it counts what the client issued, which is the
    // thing that costs a round trip.
    const queries: string[] = [];
    const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL });
    const client = new PrismaClient({ adapter, log: [{ emit: 'event', level: 'query' }] });
    (client as unknown as { $on: (e: 'query', cb: (v: { query: string }) => void) => void }).$on(
      'query',
      (event) => queries.push(event.query),
    );

    try {
      await importFile(client, file);
    } finally {
      await client.$disconnect();
    }

    const writes = queries.filter((q) => /^\s*(INSERT|UPDATE)/i.test(q));

    // 600 rows across one full chunk of 500 entries and a partial second.
    // The bound is generous on purpose: this asserts the SHAPE of the cost,
    // not an exact plan, so refactoring within the batched design is free
    // while a return to per-row writes fails immediately.
    expect(writes.length).toBeLessThan(30);

    expect(await prisma.entry.count({ where: { nawatContent: { startsWith: 'probe-' } } })).toBe(
      300,
    );
  });
});
