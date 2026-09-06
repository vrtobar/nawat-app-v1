import { prisma } from '@nahuat/database';
import { Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';

// Terminus has no built-in Prisma indicator, so this is one.
//
// ⚠️ IT READS A TABLE RATHER THAN RUNNING `SELECT 1`, and that is the whole
// point of it. `SELECT 1` needs a connection and nothing else, so it succeeds
// against a database with no schema at all — which is not a hypothetical:
// production and staging were both brought up on 2026-09-05 with RDS created
// and migrations not yet run, and this endpoint answered 200 with
// `database: up` while every route that touched a table returned 500 on
// `The table public.dialects does not exist`. A readiness check that cannot
// distinguish "connected" from "able to serve" is reporting on the wrong
// question, and nothing downstream could tell the difference.
//
// Through the Prisma model API rather than raw SQL, so the generated client,
// the connection and the schema are exercised on the same path a request
// takes. A raw query proves the socket works and skips everything the
// application actually depends on.
//
// AN EMPTY TABLE IS STILL UP. Readiness asks whether this instance can serve,
// not whether anyone has authored content — a freshly seeded environment with
// zero rows is ready, and findFirst returns null there without raising.
//
// Dialects specifically: it is reference data, the migration and the seed both
// have to have run for it to be readable, and it is what the dictionary reads
// first. Coupling the check to a real model is deliberate — if this table
// stops being readable the API cannot serve its main surface, which is exactly
// when readiness should fail.
@Injectable()
export class PrismaHealthIndicator {
  private readonly logger = new Logger(PrismaHealthIndicator.name);

  constructor(private readonly healthIndicatorService: HealthIndicatorService) {}

  async isHealthy(key: string) {
    const indicator = this.healthIndicatorService.check(key);

    try {
      await prisma.dialect.findFirst({ select: { code: true } });
      return indicator.up();
    } catch (error) {
      // The driver's message is logged, never returned. /api/health/ready is
      // @Public(), and a Postgres connection failure names the host, port and
      // database — "Can't reach database server at nahuat-production-...:5432".
      // That is free reconnaissance for an unauthenticated caller, and the
      // detail only helps someone who can already read the logs.
      this.logger.error(
        `Database health check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );

      // One message for both causes. A caller learns the API cannot serve; it
      // does not learn whether that is an unreachable host or a missing table,
      // and the second is as useful to someone probing as the first. The log
      // carries the distinction for anyone entitled to it.
      return indicator.down({ message: 'Database is unavailable' });
    }
  }
}
