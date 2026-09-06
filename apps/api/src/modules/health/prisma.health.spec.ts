import { Logger } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaHealthIndicator } from './prisma.health';

const findFirst = vi.fn();

vi.mock('@nahuat/database', () => ({
  prisma: {
    dialect: {
      findFirst: (...args: unknown[]) => findFirst(...args),
    },
  },
}));

describe('PrismaHealthIndicator', () => {
  const buildIndicator = async () => {
    const up = vi.fn().mockReturnValue({ database: { status: 'up' } });
    const down = vi.fn().mockImplementation((payload: unknown) => ({
      database: { status: 'down', ...(payload as object) },
    }));

    const moduleRef = await Test.createTestingModule({
      providers: [
        PrismaHealthIndicator,
        { provide: HealthIndicatorService, useValue: { check: () => ({ up, down }) } },
      ],
    }).compile();

    return { indicator: moduleRef.get(PrismaHealthIndicator), up, down };
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    findFirst.mockReset();
  });

  it('reports up when the table is readable', async () => {
    findFirst.mockResolvedValue({ code: 'common' });
    const { indicator, up, down } = await buildIndicator();

    await indicator.isHealthy('database');

    expect(up).toHaveBeenCalledOnce();
    expect(down).not.toHaveBeenCalled();
  });

  // Readiness asks whether this instance can serve, not whether anyone has
  // authored anything. A migrated database with no rows is ready, and findFirst
  // returns null there rather than raising.
  it('reports up when the table is readable and empty', async () => {
    findFirst.mockResolvedValue(null);
    const { indicator, up, down } = await buildIndicator();

    await indicator.isHealthy('database');

    expect(up).toHaveBeenCalledOnce();
    expect(down).not.toHaveBeenCalled();
  });

  // THE CASE THIS INDICATOR EXISTS FOR. Both environments were brought up on
  // 2026-09-05 with RDS created and migrations not run; the old `SELECT 1`
  // needed only a connection, so it answered `up` while every route touching a
  // table returned 500. A connection is not readiness.
  it('reports down when the schema is missing, not just when the host is', async () => {
    findFirst.mockRejectedValue(
      new Error('The table `public.dialects` does not exist in the current database.'),
    );
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { indicator, up, down } = await buildIndicator();
    await indicator.isHealthy('database');

    expect(up).not.toHaveBeenCalled();
    expect(down).toHaveBeenCalledWith({ message: 'Database is unavailable' });
    expect(logged).toHaveBeenCalledOnce();
  });

  // It reads through the model API rather than raw SQL, so the generated client
  // and the schema are on the same path a request takes.
  it('reads a real table rather than a constant', async () => {
    findFirst.mockResolvedValue(null);
    const { indicator } = await buildIndicator();

    await indicator.isHealthy('database');

    expect(findFirst).toHaveBeenCalledWith({ select: { code: true } });
  });

  // The endpoint this feeds is @Public(). A Prisma connection error names the
  // host, port and database, so returning it hands an unauthenticated caller a
  // map of the private subnet.
  it('does not leak the driver message to the caller', async () => {
    const detail =
      "Can't reach database server at nahuat-production.abc123.us-east-1.rds.amazonaws.com:5432";
    findFirst.mockRejectedValue(new Error(detail));
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { indicator, down } = await buildIndicator();
    const result = await indicator.isHealthy('database');

    expect(down).toHaveBeenCalledWith({ message: 'Database is unavailable' });
    expect(JSON.stringify(result)).not.toContain('rds.amazonaws.com');
    expect(JSON.stringify(result)).not.toContain('5432');

    // ...and the detail is still recoverable by someone reading the logs.
    expect(logged).toHaveBeenCalledOnce();
    expect(logged.mock.calls[0]?.[0]).toContain(detail);
  });

  it('survives a rejection that is not an Error', async () => {
    findFirst.mockRejectedValue('connection reset');
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { indicator, down } = await buildIndicator();

    await expect(indicator.isHealthy('database')).resolves.toBeDefined();
    expect(down).toHaveBeenCalledWith({ message: 'Database is unavailable' });
  });
});
