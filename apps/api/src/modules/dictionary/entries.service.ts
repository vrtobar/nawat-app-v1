import { Prisma, prisma } from '@nahuat/database';
import {
  API_ERROR_CODES,
  type CreateEntry,
  type CreateFullEntry,
  DICTIONARY_ENTRY_TYPES,
  type DictionaryBrowseParams,
  type DictionaryEntryDetail,
  type DictionaryEntryListItem,
  type DictionarySearchParams,
  type ImageRendition,
  ImageRenditionSchema,
  type JwtClaims,
  type Locale,
  type PaginationMeta,
  slugifyNawat,
  type UpdateEntry,
} from '@nahuat/shared';
import { ConflictException, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { isPrismaError, PRISMA_ERROR, uniqueViolationFields } from '../../common/prisma-error';
import {
  dialectNotFound,
  editConflict,
  entryNotFound,
  publishedEditForbidden,
  translationInUse,
} from './dictionary-errors';
import {
  resolveContent,
  toTranslationDetail,
  TRANSLATION_DETAIL_SELECT,
} from './translation-detail';

// Columns needed to render a list row's primaryTranslation and to resolve its
// content to one locale. contentEs and contentEn are both selected so the
// resolver can pick by locale; the rest map straight onto PrimaryTranslation.
const PRIMARY_SELECT = {
  id: true,
  dialectCode: true,
  partOfSpeech: true,
  phonetic: true,
  audioUrl: true,
  contentEs: true,
  contentEn: true,
} satisfies Prisma.TranslationSelect;

// A browse/search row: the entry columns a list item needs plus its candidate
// translations projected through PRIMARY_SELECT. Derived from that const so the
// row type and the query select cannot drift. The nested where/orderBy do not
// affect this shape, so browse and search share it despite differing filters.
type ListEntryRow = Prisma.EntryGetPayload<{
  select: {
    id: true;
    type: true;
    nawatContent: true;
    slug: true;
    imageUrl: true;
    isPublished: true;
    createdAt: true;
    translations: { select: typeof PRIMARY_SELECT };
  };
}>;

// An entry detail row: the columns DictionaryEntryDetail needs plus creator and
// its translations projected through TRANSLATION_DETAIL_SELECT. Derived from
// that const so the row type cannot drift from the query. The nested
// where/orderBy do not affect this shape, so the public read (findById,
// published-only) and the write responses (create/update, drafts included)
// share it despite differing filters.
type EntryDetailRow = Prisma.EntryGetPayload<{
  select: {
    id: true;
    type: true;
    nawatContent: true;
    slug: true;
    imageUrl: true;
    imageRenditions: true;
    isPublished: true;
    createdAt: true;
    updatedAt: true;
    creator: { select: { name: true } };
    translations: { select: typeof TRANSLATION_DETAIL_SELECT };
  };
}>;

@Injectable()
export class EntriesService {
  // Public dictionary browse. Live entries only — the ?isPublished param is
  // accepted by the schema but has no effect here: this route is @Public, so
  // there is no req.user to authorize a draft view against. A privileged browse
  // that honours it lands with the authenticated admin paths.
  async browse(
    params: DictionaryBrowseParams,
    locale: Locale,
  ): Promise<{ data: DictionaryEntryListItem[]; meta: PaginationMeta }> {
    // The translation that must exist for an entry to appear, and from which its
    // primary is chosen. Renderable = published, not deleted, and carrying
    // content in the resolved locale. contentEs is non-null in the schema so the
    // locale clause only ever bites for English. dialectCode and partOfSpeech
    // narrow both visibility and the primary pick together, so filtering by
    // ?partOfSpeech=NOUN shows entries with a noun reading, that noun as primary.
    const renderable: Prisma.TranslationWhereInput = {
      isPublished: true,
      deletedAt: null,
      ...(locale === 'en' ? { contentEn: { not: null } } : {}),
      ...(params.dialectCode ? { dialectCode: params.dialectCode } : {}),
      ...(params.partOfSpeech ? { partOfSpeech: params.partOfSpeech } : {}),
    };

    const where: Prisma.EntryWhereInput = {
      isPublished: true,
      deletedAt: null,
      // PHRASE is lesson-only. Fence the public dictionary to WORD/EXPRESSION; a
      // ?type= (constrained to that subset by DictionaryBrowseParamsSchema)
      // narrows within it. Hardcoded like isPublished above — a privileged
      // browse that shows every type lands with the authenticated admin paths.
      type: params.type ?? { in: [...DICTIONARY_ENTRY_TYPES] },
      // Semi-join, not a JS filter: an entry with no renderable translation is
      // excluded in SQL so the page counts stay correct. Matches entries_live_idx
      // (WHERE is_published AND deleted_at IS NULL, ordered by nawat_content).
      translations: { some: renderable },
    };

    const { page, limit } = params;

    const [total, rows] = await Promise.all([
      prisma.entry.count({ where }),
      prisma.entry.findMany({
        where,
        orderBy: { nawatContent: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          type: true,
          nawatContent: true,
          slug: true,
          imageUrl: true,
          isPublished: true,
          createdAt: true,
          // Same predicate as the semi-join, so a matched entry always carries
          // at least one candidate. Ordered by dialect precedence, so [0] is the
          // headword; dialectCode makes any shared precedence deterministic.
          translations: {
            where: renderable,
            orderBy: [{ dialect: { precedence: 'asc' } }, { dialectCode: 'asc' }],
            select: PRIMARY_SELECT,
          },
        },
      }),
    ]);

    return {
      data: rows.map((entry) => toListItem(entry, locale)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // Public fuzzy search. pg_trgm similarity ranking has no expression in
  // Prisma's query builder — no `%` operator, no ORDER BY similarity() — so the
  // ranking is raw SQL. Every column is wrapped in immutable_unaccent() so the
  // match is accent-insensitive ("takat" finds "tàkat") and uses the functional
  // GIN indexes from 20260820163000_accent_insensitive_trigram_search. The raw
  // query returns ranked ids only; the rows are hydrated through Prisma with the
  // same select and renderable filter as browse, so both endpoints resolve a
  // primary identically and share toListItem.
  async search(
    params: DictionarySearchParams,
    locale: Locale,
  ): Promise<{ data: DictionaryEntryListItem[]; meta: PaginationMeta }> {
    const { q, page, limit } = params;
    const offset = (page - 1) * limit;

    // FROM/WHERE shared by the ranking query and its count, so the page total
    // matches the rows. immutable_unaccent wraps both sides of every match,
    // which folds accents and lets the planner use the functional indexes.
    const enOnly = locale === 'en' ? Prisma.sql`AND t.content_en IS NOT NULL` : Prisma.empty;
    const dialectFilter = params.dialectCode
      ? Prisma.sql`AND t.dialect_code = ${params.dialectCode}`
      : Prisma.empty;
    // The enum column will not compare against a bare text parameter — Postgres
    // needs the cast to the generated "EntryType" type.
    const typeFilter = params.type
      ? Prisma.sql`AND e.type = ${params.type}::"EntryType"`
      : Prisma.empty;
    // PHRASE is lesson-only — fence search to the dictionary subset, same rule
    // as browse. A ?type= (already within the subset) narrows further above.
    const dictionaryTypeFilter = Prisma.sql`AND e.type IN (${Prisma.join(
      DICTIONARY_ENTRY_TYPES.map((t) => Prisma.sql`${t}::"EntryType"`),
    )})`;

    const matches = Prisma.sql`
      FROM entries e
      JOIN translations t
        ON t.entry_id = e.id
       AND t.is_published = true
       AND t.deleted_at IS NULL
       ${enOnly}
       ${dialectFilter}
      WHERE e.is_published = true
        AND e.deleted_at IS NULL
        ${dictionaryTypeFilter}
        ${typeFilter}
        AND (
          immutable_unaccent(e.nawat_content) % immutable_unaccent(${q})
          OR immutable_unaccent(t.content_es) % immutable_unaccent(${q})
          OR (t.content_en IS NOT NULL
              AND immutable_unaccent(t.content_en) % immutable_unaccent(${q}))
        )
    `;

    const [ranked, countRows] = await Promise.all([
      // score is the entry's best match across its headword and any renderable
      // translation, in either language; GREATEST/COALESCE keep a null contentEn
      // from voiding the row. Ordered by score, then headword for a stable tie.
      prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT e.id AS id,
               MAX(GREATEST(
                 similarity(immutable_unaccent(e.nawat_content), immutable_unaccent(${q})),
                 similarity(immutable_unaccent(t.content_es), immutable_unaccent(${q})),
                 COALESCE(similarity(immutable_unaccent(t.content_en), immutable_unaccent(${q})), 0)
               )) AS score
        ${matches}
        GROUP BY e.id
        ORDER BY score DESC, e.nawat_content ASC
        LIMIT ${limit} OFFSET ${offset}
      `),
      prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(DISTINCT e.id) AS count ${matches}
      `),
    ]);

    const total = Number(countRows[0]?.count ?? 0);
    const meta: PaginationMeta = { total, page, limit, totalPages: Math.ceil(total / limit) };

    if (ranked.length === 0) {
      return { data: [], meta };
    }

    // Hydrate the ranked ids. findMany does not preserve `IN (...)` order, so
    // the rows are re-sorted back to the ranking below. The renderable filter
    // mirrors browse (minus partOfSpeech, which search does not take), so the
    // primary is picked from the same candidates the ranking searched.
    const ids = ranked.map((r) => r.id);
    const renderable: Prisma.TranslationWhereInput = {
      isPublished: true,
      deletedAt: null,
      ...(locale === 'en' ? { contentEn: { not: null } } : {}),
      ...(params.dialectCode ? { dialectCode: params.dialectCode } : {}),
    };

    const rows = await prisma.entry.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        type: true,
        nawatContent: true,
        slug: true,
        imageUrl: true,
        isPublished: true,
        createdAt: true,
        translations: {
          where: renderable,
          orderBy: [{ dialect: { precedence: 'asc' } }, { dialectCode: 'asc' }],
          select: PRIMARY_SELECT,
        },
      },
    });

    const byId = new Map(rows.map((row) => [row.id, row]));
    const data = ids.flatMap((id): DictionaryEntryListItem[] => {
      const entry = byId.get(id);
      // An id ranked by the raw query but absent here would mean the raw match
      // and the Prisma renderable filter disagree; skip rather than emit a
      // malformed row. Not expected — the two encode the same predicate.
      return entry ? [toListItem(entry, locale)] : [];
    });

    return { data, meta };
  }

  // Public entry detail. All renderable translations, every dialect, ordered by
  // priority. findFirst rather than findUnique because the visibility predicate
  // is part of the match: an unpublished or soft-deleted entry is reported as
  // not found, identical to one that never existed, so a draft's existence is
  // not disclosed to an anonymous caller.
  async findById(id: string, locale: Locale): Promise<DictionaryEntryDetail> {
    const entry = await prisma.entry.findFirst({
      where: { id, isPublished: true, deletedAt: null },
      select: readDetailSelect(locale),
    });

    if (!entry) throw entryNotFound();

    return toEntryDetail(entry, locale);
  }

  // Public entry detail by slug — the dictionary's canonical URL path
  // (/dictionary/[slug]). Same visibility predicate and shape as findById: an
  // unpublished, soft-deleted, or non-existent slug is reported as not found, so
  // the two ways into the same page behave identically. No type filter, matching
  // findById — a slug is only surfaced by browse/search, which already exclude
  // PHRASE, so the dictionary UI never hands out a lesson-phrase slug.
  async findBySlug(slug: string, locale: Locale): Promise<DictionaryEntryDetail> {
    const entry = await prisma.entry.findFirst({
      where: { slug, isPublished: true, deletedAt: null },
      select: readDetailSelect(locale),
    });

    if (!entry) throw entryNotFound();

    return toEntryDetail(entry, locale);
  }

  // Create a draft entry (CONTRIBUTOR). isPublished stays at its schema default
  // of false — publishing is a separate ADMIN action. creatorId and updaterId
  // are stamped from the caller's token, never the body, so attribution cannot
  // be spoofed. Returns the created entry in the same detail shape a read does,
  // resolved to the caller's locale; a fresh shell has no translations yet.
  async create(input: CreateEntry, userId: string, locale: Locale): Promise<DictionaryEntryDetail> {
    try {
      const entry = await prisma.entry.create({
        data: {
          ...input,
          slug: slugifyNawat(input.nawatContent),
          creatorId: userId,
          updaterId: userId,
        },
        select: writeDetailSelect(locale),
      });
      return toEntryDetail(entry, locale);
    } catch (error) {
      // slug is unique too — two headwords that fold to the same slug collide
      // there, not on nawatContent, and want the clearer message. Checked first.
      if (uniqueViolationFields(error).includes('slug')) throw entrySlugConflict();
      // nawatContent is unique — a duplicate headword collides. Generic
      // CONFLICT: the client knows the word already exists without the response
      // disclosing which id holds it.
      if (isPrismaError(error, PRISMA_ERROR.UNIQUE_VIOLATION)) throw entryConflict();
      throw error;
    }
  }

  // Update an entry's own fields. CONTRIBUTOR may edit only drafts — a published
  // entry is refused (publishedEditForbidden) so live content is not changed
  // without review; ADMIN edits published directly. The row is read first to
  // decide that and to tell a genuine not-found from a gated-published one; a
  // soft-deleted row is not found. updaterId is re-stamped from the token.
  async update(
    id: string,
    input: UpdateEntry,
    userId: string,
    role: JwtClaims['role'],
    locale: Locale,
  ): Promise<DictionaryEntryDetail> {
    // The precondition is not a column — destructured out so it cannot be spread
    // into `data`. Prisma's generated types reject an unknown key there, so
    // forgetting this fails the typecheck rather than at runtime.
    const { expectedUpdatedAt, ...changes } = input;

    // NOT scoped to the caller's own rows. Any contributor may edit any entry —
    // ownership is attribution, not permission — so the only per-row gate left
    // here is the published-content one below. See ./ownership.
    const existing = await prisma.entry.findFirst({
      where: { id, deletedAt: null },
      select: { isPublished: true },
    });
    if (!existing) throw entryNotFound();
    if (existing.isPublished && role !== 'ADMIN') throw publishedEditForbidden();

    // THE CONDITIONAL UPDATE IS THE AUTHORITY, not the read above. `updatedAt`
    // is matched in the WHERE, so a row that moved between the read that filled
    // the form and this write matches nothing and updates nothing — rather than
    // overwriting a change the caller never saw. The read's only job is to
    // classify the refusal (404 vs 403); this decides whether the write happens.
    let result;
    try {
      result = await prisma.entry.updateMany({
        where: { id, deletedAt: null, updatedAt: new Date(expectedUpdatedAt) },
        data: {
          ...changes,
          // Regenerate the slug only when the headword changes; a rename can
          // collide with another entry's slug, same as a create.
          ...(changes.nawatContent !== undefined
            ? { slug: slugifyNawat(changes.nawatContent) }
            : {}),
          updaterId: userId,
        },
      });
    } catch (error) {
      if (uniqueViolationFields(error).includes('slug')) throw entrySlugConflict();
      if (isPrismaError(error, PRISMA_ERROR.UNIQUE_VIOLATION)) throw entryConflict();
      throw error;
    }

    // Nothing matched. The read above already established the row exists and is
    // editable, so the only thing that can have changed is updatedAt — unless
    // the row was deleted in between, which one extra read distinguishes. Paid
    // only on the failure path, where the better message is worth it.
    if (result.count === 0) {
      const stillThere = await prisma.entry.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      throw stillThere ? editConflict('entry') : entryNotFound();
    }

    const entry = await prisma.entry.findFirst({
      where: { id },
      select: writeDetailSelect(locale),
    });
    // Unreachable barring a delete raced between the two reads; the guard keeps
    // the type honest rather than asserting non-null on a nullable findFirst.
    if (!entry) throw entryNotFound();
    return toEntryDetail(entry, locale);
  }

  // Create an entry and its first translations in one request (CONTRIBUTOR).
  // Prisma's nested `create` runs the entry and every translation in a single
  // transaction, so a bad translation (a repeated dialect, an unknown dialect)
  // rolls the whole thing back — an entry never lands half-populated.
  async createFull(
    input: CreateFullEntry,
    userId: string,
    locale: Locale,
  ): Promise<DictionaryEntryDetail> {
    const { translations, ...entry } = input;
    const translationData = translations.map((t) => ({
      ...t,
      creatorId: userId,
      updaterId: userId,
    }));

    try {
      const created = await prisma.entry.create({
        data: {
          ...entry,
          slug: slugifyNawat(entry.nawatContent),
          creatorId: userId,
          updaterId: userId,
          translations: { create: translationData },
        },
        select: writeDetailSelect(locale),
      });
      return toEntryDetail(created, locale);
    } catch (error) {
      // A slug collision is distinct from the others below and clearer named.
      if (uniqueViolationFields(error).includes('slug')) throw entrySlugConflict();
      // UNIQUE_VIOLATION is either a duplicate nawatContent or two batch
      // translations sharing a dialect (one translation per dialect per entry);
      // both are a client conflict. A FK failure is an unknown dialectCode.
      if (isPrismaError(error, PRISMA_ERROR.UNIQUE_VIOLATION)) throw entryConflict();
      if (isPrismaError(error, PRISMA_ERROR.FK_CONSTRAINT)) throw dialectNotFound();
      throw error;
    }
  }

  // Publish an entry and its draft translations in one action (ADMIN). Publish
  // is entry-level: there is no standalone "publish one translation", so this is
  // the single button that takes an entry live. Unconditional — ADR 15 exempts
  // the dictionary from the publish gate lessons carry, so an entry is
  // publishable with Spanish alone. Idempotent (re-running it publishes any
  // translation added since), transactional, and guarded on deletedAt.
  async publish(id: string, userId: string, locale: Locale): Promise<DictionaryEntryDetail> {
    await prisma.$transaction(async (tx) => {
      const result = await tx.entry.updateMany({
        where: { id, deletedAt: null },
        data: { isPublished: true, updaterId: userId },
      });
      if (result.count === 0) throw entryNotFound();
      // Only the drafts, so already-published rows are not needlessly re-stamped.
      await tx.translation.updateMany({
        where: { entryId: id, deletedAt: null, isPublished: false },
        data: { isPublished: true, updaterId: userId },
      });
    });

    const entry = await prisma.entry.findFirst({
      where: { id },
      select: writeDetailSelect(locale),
    });
    if (!entry) throw entryNotFound();
    return toEntryDetail(entry, locale);
  }

  // Returns a published entry to draft, cascading to its translations exactly
  // as publish cascades the other way. ADMIN.
  //
  // WHY THIS EXISTS. Publishing was one-way: nothing accepted isPublished on an
  // update, so a mistake could only be resolved by deleting the row and
  // recreating it — losing its id, its slug and its attribution over a wrong
  // gloss. Deletion is a poor substitute for a correction.
  //
  // The cascade is the mirror of publish's: that one promotes only the entry's
  // DRAFT translations, so already-published rows are not re-stamped, and this
  // one demotes only its PUBLISHED ones for the same reason.
  //
  // Not guarded against learning content that references a translation, unlike
  // delete — no referencing module is built yet, so there is nothing to check
  // and a guard written now would be untested against its real case. Worth
  // revisiting alongside lessons: unpublishing a word cited by a live lesson is
  // the same class of problem TRANSLATION_IN_USE exists for.
  async unpublish(id: string, userId: string, locale: Locale): Promise<DictionaryEntryDetail> {
    await prisma.$transaction(async (tx) => {
      const result = await tx.entry.updateMany({
        where: { id, deletedAt: null },
        data: { isPublished: false, updaterId: userId },
      });
      if (result.count === 0) throw entryNotFound();
      // Only the published ones, so drafts are not needlessly re-stamped.
      await tx.translation.updateMany({
        where: { entryId: id, deletedAt: null, isPublished: true },
        data: { isPublished: false, updaterId: userId },
      });
    });

    const entry = await prisma.entry.findFirst({
      where: { id },
      select: writeDetailSelect(locale),
    });
    if (!entry) throw entryNotFound();
    return toEntryDetail(entry, locale);
  }

  // Delete an entry and its translations in one transaction (ADMIN). An entry
  // owns its translations — meaningless without it — so removing the entry
  // removes them, all-or-nothing: a failure mid-cascade rolls the whole thing
  // back rather than leaving an entry stripped of some translations. Any
  // translation still referenced by learning content blocks the delete
  // (TRANSLATION_IN_USE). Soft delete keeps published rows for history, hard
  // delete removes drafts; the entry follows its own published/draft rule. A
  // draft entry can only hold draft translations — nothing publishes a
  // translation but the entry publish — so its hard delete never strands a row.
  async delete(id: string, userId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const entry = await tx.entry.findFirst({
        where: { id, deletedAt: null },
        select: { isPublished: true },
      });
      if (!entry) throw entryNotFound();

      const translations = await tx.translation.findMany({
        where: { entryId: id, deletedAt: null },
        select: {
          id: true,
          isPublished: true,
          _count: {
            select: {
              flashcards: true,
              lessonVocabulary: true,
              exerciseTranslations: true,
              userCardProgress: true,
            },
          },
        },
      });

      const references = translations.reduce(
        (sum, t) =>
          sum +
          t._count.flashcards +
          t._count.lessonVocabulary +
          t._count.exerciseTranslations +
          t._count.userCardProgress,
        0,
      );
      if (references > 0) throw translationInUse(references);

      const publishedIds = translations.filter((t) => t.isPublished).map((t) => t.id);
      const draftIds = translations.filter((t) => !t.isPublished).map((t) => t.id);
      if (publishedIds.length > 0) {
        await tx.translation.updateMany({
          where: { id: { in: publishedIds } },
          data: { deletedAt: new Date(), updaterId: userId },
        });
      }
      if (draftIds.length > 0) {
        await tx.translation.deleteMany({ where: { id: { in: draftIds } } });
      }

      if (entry.isPublished) {
        await tx.entry.update({
          where: { id },
          data: { deletedAt: new Date(), updaterId: userId },
        });
      } else {
        await tx.entry.delete({ where: { id } });
      }
    });
  }
}

// The public entry-detail select: published, non-deleted translations only,
// resolved to one locale. Shared by findById and findBySlug so the two paths to
// the same page — by id and by the canonical slug — return an identical shape.
function readDetailSelect(locale: Locale) {
  return {
    id: true,
    type: true,
    nawatContent: true,
    slug: true,
    imageUrl: true,
    imageRenditions: true,
    isPublished: true,
    createdAt: true,
    updatedAt: true,
    creator: { select: { name: true } },
    translations: {
      where: {
        isPublished: true,
        deletedAt: null,
        ...(locale === 'en' ? { contentEn: { not: null } } : {}),
      },
      orderBy: [{ dialect: { precedence: 'asc' } }, { dialectCode: 'asc' }],
      select: TRANSLATION_DETAIL_SELECT,
    },
  } satisfies Prisma.EntrySelect;
}

// The entry detail select for write responses. Unlike the public read it does
// not restrict the entry to published rows — a contributor gets their draft
// back — and it includes draft translations (deletedAt: null only), so a
// translation added but not yet published still shows. The locale clause drops
// translations lacking content in the resolved language, as the reads do, so
// the resolver below never meets a null.
function writeDetailSelect(locale: Locale) {
  return {
    id: true,
    type: true,
    nawatContent: true,
    slug: true,
    imageUrl: true,
    imageRenditions: true,
    isPublished: true,
    createdAt: true,
    updatedAt: true,
    creator: { select: { name: true } },
    translations: {
      where: {
        deletedAt: null,
        ...(locale === 'en' ? { contentEn: { not: null } } : {}),
      },
      orderBy: [{ dialect: { precedence: 'asc' } }, { dialectCode: 'asc' }],
      select: TRANSLATION_DETAIL_SELECT,
    },
  } satisfies Prisma.EntrySelect;
}

// Maps an entry detail row to the response shape, resolving every translation
// to one locale. Shared by findById and the write paths so the detail contract
// lives in one place.
function toEntryDetail(entry: EntryDetailRow, locale: Locale): DictionaryEntryDetail {
  return {
    id: entry.id,
    type: entry.type,
    nawatContent: entry.nawatContent,
    slug: entry.slug,
    imageUrl: entry.imageUrl,
    imageRenditions: toImageRenditions(entry.imageRenditions),
    isPublished: entry.isPublished,
    creator: { name: entry.creator.name },
    translations: entry.translations.map((t) => toTranslationDetail(t, locale)),
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

// A Json column holds whatever was written to it, including something an older
// gate wrote or nothing at all. Parsed on the way out rather than asserted:
// the alternative is a cast, and a cast turns a bad row into a response that
// fails the client's own validation instead of degrading here.
//
// An unparseable ladder becomes null, which is the same answer an entry with no
// ladder gives, and the reader already handles that by falling back to
// `imageUrl`. It is not an error worth failing the page over — the image still
// renders, just without a srcset.
function toImageRenditions(value: unknown): ImageRendition[] | null {
  if (value === null || value === undefined) return null;
  const parsed = z.array(ImageRenditionSchema).safeParse(value);
  return parsed.success ? parsed.data : null;
}

function entryConflict(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.CONFLICT,
    message: 'An entry with that Nawat content already exists',
  });
}

// Distinct from entryConflict: the headword is not a duplicate (nawatContent is
// unique and passed), but it slugifies to a value another entry already holds —
// two distinct spellings folding together. Named separately so an admin sees a
// slug collision to resolve, not a false "already exists".
function entrySlugConflict(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.ENTRY_SLUG_CONFLICT,
    message: 'Another entry already uses the URL slug this Nawat content produces',
  });
}

// Maps a browse/search row to a list item, resolving its primary translation
// to one locale. Shared by both endpoints so the headword rule and the
// content resolution live in one place.
function toListItem(entry: ListEntryRow, locale: Locale): DictionaryEntryListItem {
  const primary = pickPrimary(entry.translations);
  return {
    id: entry.id,
    type: entry.type,
    nawatContent: entry.nawatContent,
    slug: entry.slug,
    imageUrl: entry.imageUrl,
    isPublished: entry.isPublished,
    createdAt: entry.createdAt.toISOString(),
    primaryTranslation: {
      id: primary.id,
      content: resolveContent(primary, locale),
      locale,
      partOfSpeech: primary.partOfSpeech,
      audioUrl: primary.audioUrl,
      phonetic: primary.phonetic,
      dialectCode: primary.dialectCode,
    },
  };
}

// The headword: the translation whose dialect has the lowest precedence, so the
// common form leads when present and a town-only word still gets a headword
// rather than being dropped. The array is pre-ordered by (dialect precedence,
// dialectCode), so that is simply [0]. Callers only reach here for entries the
// query already proved have a candidate, so [0] exists.
function pickPrimary<T>(translations: T[]): T {
  const primary = translations[0];
  if (primary === undefined) {
    // Unreachable: callers only reach here for entries the semi-join proved
    // have a candidate. A throw rather than a silent gap keeps the type honest
    // and turns any future drift into a 500 instead of a malformed row.
    throw new Error('entry matched the browse query but has no candidate translation');
  }
  return primary;
}
