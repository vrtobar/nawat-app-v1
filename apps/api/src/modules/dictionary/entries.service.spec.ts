import { prisma } from '@nahuat/database';
import {
  DictionaryBrowseParamsSchema,
  DictionaryEntryDetailSchema,
  DictionaryEntryListItemSchema,
  DictionarySearchParamsSchema,
} from '@nahuat/shared';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EntriesService } from './entries.service';

vi.mock('@nahuat/database', () => {
  // The service uses the Prisma namespace for where-input types (erased at
  // runtime) and for `Prisma.sql`/`Prisma.empty` when composing the raw search
  // query (present at runtime). $queryRaw is mocked to ignore its argument, so
  // the SQL fragments only need to exist, not be real — these tests assert the
  // mapping of the returned rows, not the SQL, which needs a live Postgres.
  const client = {
    entry: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    translation: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };
  return {
    Prisma: { sql: () => ({}), join: () => ({}), empty: {} },
    // $transaction runs the callback against the same mocked client, so tx.entry
    // is the same spy as prisma.entry — a rollback is not modelled, but these
    // tests assert which writes ran, not durability.
    prisma: { ...client, $transaction: (cb: (tx: typeof client) => unknown) => cb(client) },
  };
});

const entry = vi.mocked(prisma.entry);
const translationTable = vi.mocked(prisma.translation);
const queryRaw = vi.mocked(prisma.$queryRaw);

// As in users/dialects specs: the Prisma mock is cast to `never`, so TypeScript
// checks nothing about the row shapes fed in or the response shape out. Parsing
// every response through the shared schema's .strict() is what makes the
// resolution and mapping real — a leaked field, a Date left unserialised, or a
// primary picked from the wrong dialect fails the parse rather than passing a
// looser toMatchObject.
const translation = (overrides: Record<string, unknown> = {}) => ({
  id: 'tra_1',
  dialectCode: 'common',
  partOfSpeech: 'NOUN',
  phonetic: 'ˈta.kat',
  audioUrl: null,
  contentEs: 'hombre',
  contentEn: 'man',
  ...overrides,
});

const entryRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ent_1',
  type: 'WORD',
  nawatContent: 'takat',
  slug: 'takat',
  imageUrl: null,
  isPublished: true,
  createdAt: new Date('2026-08-01T09:00:00.000Z'),
  translations: [translation()],
  ...overrides,
});

// Detail rows carry the fuller translation shape plus the inline dialect.
const detailTranslation = (overrides: Record<string, unknown> = {}) => ({
  id: 'tra_1',
  contentEs: 'hombre',
  contentEn: 'man',
  exampleNawat: 'ne takat',
  exampleEs: 'el hombre',
  exampleEn: 'the man',
  phonetic: 'ˈta.kat',
  partOfSpeech: 'NOUN',
  audioUrl: null,
  isPublished: true,
  createdAt: new Date('2026-08-01T09:00:00.000Z'),
  updatedAt: new Date('2026-08-02T09:00:00.000Z'),
  dialect: {
    id: 'dia_1',
    code: 'common',
    nameEs: 'Nawat común',
    nameEn: 'Common Nawat',
    descriptionEs: 'La forma de uso amplio.',
    descriptionEn: 'The broadly used form.',
    precedence: 0,
  },
  ...overrides,
});

const detailRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ent_1',
  type: 'WORD',
  nawatContent: 'takat',
  slug: 'takat',
  imageUrl: null,
  imageRenditions: null,
  isPublished: true,
  createdAt: new Date('2026-08-01T09:00:00.000Z'),
  updatedAt: new Date('2026-08-02T09:00:00.000Z'),
  creator: { name: 'Victor' },
  translations: [detailTranslation()],
  ...overrides,
});

// The version the caller claims to have loaded. Mocks do not enforce the
// WHERE, so its value is arbitrary — what the tests assert is that it REACHES
// the query, and that a zero-row result becomes a conflict.
const LOADED_AT = '2026-08-24T00:00:00.000Z';

describe('EntriesService', () => {
  const service = new EntriesService();

  beforeEach(() => vi.resetAllMocks());

  describe('browse', () => {
    it('returns list items in the contract shape with resolved Spanish content', async () => {
      entry.count.mockResolvedValue(1 as never);
      entry.findMany.mockResolvedValue([entryRow()] as never);

      const result = await service.browse({ page: 1, limit: 20 }, 'es');

      result.data.forEach((item) => DictionaryEntryListItemSchema.strict().parse(item));
      expect(result.data[0]).toMatchObject({
        primaryTranslation: { content: 'hombre', locale: 'es', dialectCode: 'common' },
      });
      expect(result.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
    });

    it('resolves English content and derives totalPages from the count', async () => {
      entry.count.mockResolvedValue(45 as never);
      entry.findMany.mockResolvedValue([entryRow()] as never);

      const result = await service.browse({ page: 2, limit: 20 }, 'en');

      expect(result.data[0]).toMatchObject({
        primaryTranslation: { content: 'man', locale: 'en' },
      });
      // Page 2 of 45 at 20/page → 3 pages, offset 20.
      expect(result.meta).toEqual({ total: 45, page: 2, limit: 20, totalPages: 3 });
      expect(entry.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 20 }));
    });

    it('orders the nested translations by dialect precedence and picks the first as primary', async () => {
      // The query orders translations by dialect precedence, so [0] is the
      // headword. The mock returns them already ordered (common leads); the
      // service must pick that first row and must ask for the precedence order.
      entry.count.mockResolvedValue(1 as never);
      entry.findMany.mockResolvedValue([
        entryRow({
          translations: [
            translation({ id: 'tra_co', dialectCode: 'common' }),
            translation({ id: 'tra_iz', dialectCode: 'izalco', contentEs: 'takat izalco' }),
          ],
        }),
      ] as never);

      const result = await service.browse({ page: 1, limit: 20 }, 'es');

      expect(result.data[0]).toMatchObject({
        primaryTranslation: { id: 'tra_co', dialectCode: 'common' },
      });
      expect(entry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            translations: expect.objectContaining({
              orderBy: [{ dialect: { precedence: 'asc' } }, { dialectCode: 'asc' }],
            }),
          }),
        }),
      );
    });

    it('gives a town-only entry a headword — the first present dialect', async () => {
      // No common form. Ordered by precedence, the highest-precedence dialect the
      // entry does have leads, so the entry still gets a headword rather than
      // being dropped.
      entry.count.mockResolvedValue(1 as never);
      entry.findMany.mockResolvedValue([
        entryRow({
          translations: [
            translation({ id: 'tra_iz', dialectCode: 'izalco', contentEs: 'takat izalco' }),
            translation({ id: 'tra_sd', dialectCode: 'santo-domingo' }),
          ],
        }),
      ] as never);

      const result = await service.browse({ page: 1, limit: 20 }, 'es');

      expect(result.data[0]).toMatchObject({
        primaryTranslation: { id: 'tra_iz', dialectCode: 'izalco', content: 'takat izalco' },
      });
    });

    it('requires English content in the query when the locale is English', async () => {
      entry.count.mockResolvedValue(0 as never);
      entry.findMany.mockResolvedValue([] as never);

      await service.browse({ page: 1, limit: 20 }, 'en');

      // The renderable filter must exclude translations without an English form;
      // for Spanish it must not, since contentEs is mandatory.
      expect(entry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            translations: { some: expect.objectContaining({ contentEn: { not: null } }) },
          }),
        }),
      );
    });

    it('narrows visibility and the primary pick by dialect and part of speech', async () => {
      entry.count.mockResolvedValue(0 as never);
      entry.findMany.mockResolvedValue([] as never);

      await service.browse(
        { page: 1, limit: 20, dialectCode: 'izalco', partOfSpeech: 'VERB', type: 'WORD' },
        'es',
      );

      expect(entry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: 'WORD',
            translations: {
              some: expect.objectContaining({ dialectCode: 'izalco', partOfSpeech: 'VERB' }),
            },
          }),
        }),
      );
    });

    it('fences the public dictionary to WORD and EXPRESSION when no type is given', async () => {
      entry.count.mockResolvedValue(0 as never);
      entry.findMany.mockResolvedValue([] as never);

      // PHRASE is lesson-only, so an unfiltered browse must exclude it rather
      // than return every type.
      await service.browse({ page: 1, limit: 20 }, 'es');

      expect(entry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ type: { in: ['WORD', 'EXPRESSION'] } }),
        }),
      );
    });
  });

  describe('findById', () => {
    it('returns the entry detail in the contract shape', async () => {
      entry.findFirst.mockResolvedValue(detailRow() as never);

      const result = await service.findById('ent_1', 'es');

      DictionaryEntryDetailSchema.strict().parse(result);
      expect(result).toMatchObject({
        nawatContent: 'takat',
        creator: { name: 'Victor' },
      });
      expect(result.translations[0]).toMatchObject({
        content: 'hombre',
        example: 'el hombre',
        exampleNawat: 'ne takat',
        locale: 'es',
      });
    });

    it('returns the rendition ladder the gate stored', async () => {
      entry.findFirst.mockResolvedValue(
        detailRow({
          imageUrl: 'https://cdn.nahuat.com/med_1/640.webp',
          imageRenditions: [
            { width: 320, height: 427, url: 'https://cdn.nahuat.com/med_1/320.webp' },
            { width: 640, height: 853, url: 'https://cdn.nahuat.com/med_1/640.webp' },
          ],
        }) as never,
      );

      const result = await service.findById('ent_1', 'es');

      DictionaryEntryDetailSchema.strict().parse(result);
      expect(result.imageRenditions).toEqual([
        { width: 320, height: 427, url: 'https://cdn.nahuat.com/med_1/320.webp' },
        { width: 640, height: 853, url: 'https://cdn.nahuat.com/med_1/640.webp' },
      ]);
    });

    it('degrades an unreadable ladder to null rather than failing the page', async () => {
      // A Json column holds whatever was written to it. The image still renders
      // from imageUrl; only the srcset is lost, which is not worth a 500.
      entry.findFirst.mockResolvedValue(
        detailRow({
          imageUrl: 'https://cdn.nahuat.com/med_1/640.webp',
          imageRenditions: [{ width: 640, url: 'https://cdn.nahuat.com/med_1/640.webp' }],
        }) as never,
      );

      const result = await service.findById('ent_1', 'es');

      DictionaryEntryDetailSchema.strict().parse(result);
      expect(result.imageRenditions).toBeNull();
      expect(result.imageUrl).toBe('https://cdn.nahuat.com/med_1/640.webp');
    });

    it('resolves each translation to English, example included', async () => {
      entry.findFirst.mockResolvedValue(detailRow() as never);

      const result = await service.findById('ent_1', 'en');

      expect(result.translations[0]).toMatchObject({
        content: 'man',
        example: 'the man',
        locale: 'en',
      });
    });

    it('keeps a missing example null', async () => {
      entry.findFirst.mockResolvedValue(
        detailRow({ translations: [detailTranslation({ exampleEs: null })] }) as never,
      );

      const result = await service.findById('ent_1', 'es');

      expect(result.translations[0]?.example).toBeNull();
    });

    it('404s ENTRY_NOT_FOUND when nothing live matches the id', async () => {
      entry.findFirst.mockResolvedValue(null as never);

      const rejection = service.findById('nope', 'es');
      await expect(rejection).rejects.toBeInstanceOf(NotFoundException);
      await rejection.catch((error: { getResponse(): { code: string } }) => {
        expect(error.getResponse()).toMatchObject({ code: 'ENTRY_NOT_FOUND' });
      });
    });
  });

  // $queryRaw is called twice, in Promise.all order: [0] ranks the ids, [1]
  // counts distinct matches. entry.findMany then hydrates. The SQL itself
  // (accent folding, similarity threshold, index use) is beyond a unit test and
  // needs a live Postgres; these cover the ordering, hydration and meta.
  describe('findBySlug', () => {
    it('returns the entry detail for a published slug, in the contract shape', async () => {
      entry.findFirst.mockResolvedValue(detailRow() as never);

      const result = await service.findBySlug('takat', 'es');

      DictionaryEntryDetailSchema.strict().parse(result);
      expect(result).toMatchObject({ slug: 'takat', nawatContent: 'takat' });
      expect(entry.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { slug: 'takat', isPublished: true, deletedAt: null } }),
      );
    });

    it('404s ENTRY_NOT_FOUND when no live entry has that slug', async () => {
      entry.findFirst.mockResolvedValue(null as never);

      const rejection = service.findBySlug('nope', 'es');
      await expect(rejection).rejects.toBeInstanceOf(NotFoundException);
      await rejection.catch((error: { getResponse(): { code: string } }) => {
        expect(error.getResponse()).toMatchObject({ code: 'ENTRY_NOT_FOUND' });
      });
    });
  });

  describe('search', () => {
    it('hydrates in the ranking order, not alphabetically, in the contract shape', async () => {
      queryRaw
        .mockResolvedValueOnce([{ id: 'ent_b' }, { id: 'ent_a' }] as never)
        .mockResolvedValueOnce([{ count: 2n }] as never);
      // Returned in the opposite (alphabetical) order to prove the re-sort back
      // to the ranking rather than to whatever order the IN clause yields.
      entry.findMany.mockResolvedValue([
        entryRow({ id: 'ent_a', nawatContent: 'aaa' }),
        entryRow({ id: 'ent_b', nawatContent: 'bbb' }),
      ] as never);

      const result = await service.search({ q: 'takat', page: 1, limit: 20 }, 'es');

      result.data.forEach((item) => DictionaryEntryListItemSchema.strict().parse(item));
      expect(result.data.map((d) => d.id)).toEqual(['ent_b', 'ent_a']);
      expect(result.meta).toEqual({ total: 2, page: 1, limit: 20, totalPages: 1 });
    });

    it('resolves each hydrated row to the requested locale', async () => {
      queryRaw
        .mockResolvedValueOnce([{ id: 'ent_1' }] as never)
        .mockResolvedValueOnce([{ count: 1n }] as never);
      entry.findMany.mockResolvedValue([entryRow()] as never);

      const result = await service.search({ q: 'man', page: 1, limit: 20 }, 'en');

      expect(result.data[0]).toMatchObject({
        primaryTranslation: { content: 'man', locale: 'en' },
      });
    });

    it('returns empty data with zeroed meta and skips hydration on no match', async () => {
      queryRaw.mockResolvedValueOnce([] as never).mockResolvedValueOnce([{ count: 0n }] as never);

      const result = await service.search({ q: 'zzz', page: 1, limit: 20 }, 'es');

      expect(result.data).toEqual([]);
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 20, totalPages: 0 });
      // No ids to hydrate — the second round trip must not run.
      expect(entry.findMany).not.toHaveBeenCalled();
    });

    it('derives totalPages from the distinct match count', async () => {
      queryRaw
        .mockResolvedValueOnce([{ id: 'ent_1' }] as never)
        .mockResolvedValueOnce([{ count: 45n }] as never);
      entry.findMany.mockResolvedValue([entryRow()] as never);

      const result = await service.search({ q: 'takat', page: 2, limit: 20 }, 'es');

      // 45 matches at 20/page → 3 pages.
      expect(result.meta).toEqual({ total: 45, page: 2, limit: 20, totalPages: 3 });
    });
  });

  describe('create', () => {
    it('creates a draft and returns it in the detail shape', async () => {
      entry.create.mockResolvedValue(detailRow({ isPublished: false, translations: [] }) as never);

      const result = await service.create({ nawatContent: 'takat', type: 'WORD' }, 'usr_1', 'es');

      DictionaryEntryDetailSchema.strict().parse(result);
      expect(result).toMatchObject({ nawatContent: 'takat', isPublished: false, translations: [] });
    });

    it('stamps attribution from the caller, not the body', async () => {
      entry.create.mockResolvedValue(detailRow({ isPublished: false, translations: [] }) as never);

      await service.create({ nawatContent: 'takat', type: 'WORD' }, 'usr_1', 'es');

      // creatorId and updaterId come from the token argument; the body has no
      // say in who a row is attributed to.
      expect(entry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ creatorId: 'usr_1', updaterId: 'usr_1' }),
        }),
      );
    });

    it('maps a duplicate nawatContent to CONFLICT', async () => {
      entry.create.mockRejectedValue({ code: 'P2002' } as never);

      const rejection = service.create({ nawatContent: 'takat', type: 'WORD' }, 'usr_1', 'es');
      await expect(rejection).rejects.toBeInstanceOf(ConflictException);
      await rejection.catch((error: { getResponse(): { code: string } }) => {
        expect(error.getResponse()).toMatchObject({ code: 'CONFLICT' });
      });
    });

    it('generates the slug from nawatContent', async () => {
      entry.create.mockResolvedValue(detailRow({ isPublished: false, translations: [] }) as never);

      await service.create({ nawatContent: 'Ken Tinemi', type: 'EXPRESSION' }, 'usr_1', 'es');

      expect(entry.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ slug: 'ken-tinemi' }) }),
      );
    });

    it('maps a slug collision to ENTRY_SLUG_CONFLICT, distinct from a duplicate headword', async () => {
      // The pg driver adapter reports the violated columns on the error cause,
      // not on meta.target — a fold-collision fires on the slug constraint.
      entry.create.mockRejectedValue({
        code: 'P2002',
        meta: { driverAdapterError: { cause: { constraint: { fields: ['slug'] } } } },
      } as never);

      const rejection = service.create({ nawatContent: 'né', type: 'WORD' }, 'usr_1', 'es');
      await expect(rejection).rejects.toBeInstanceOf(ConflictException);
      await rejection.catch((error: { getResponse(): { code: string } }) => {
        expect(error.getResponse()).toMatchObject({ code: 'ENTRY_SLUG_CONFLICT' });
      });
    });
  });

  describe('update', () => {
    it('updates a draft entry (CONTRIBUTOR) and returns the detail shape', async () => {
      entry.findFirst
        .mockResolvedValueOnce({ isPublished: false } as never) // existence + gate check
        .mockResolvedValueOnce(detailRow() as never); // read-back
      entry.updateMany.mockResolvedValue({ count: 1 } as never);

      const result = await service.update(
        'ent_1',
        { nawatContent: 'tak+', expectedUpdatedAt: LOADED_AT },
        'usr_9',
        'CONTRIBUTOR',
        'es',
      );

      DictionaryEntryDetailSchema.strict().parse(result);
      expect(entry.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // The lock reaches the WHERE, which is the whole mechanism: a row
          // whose updatedAt has moved matches nothing and is not overwritten.
          where: expect.objectContaining({
            id: 'ent_1',
            deletedAt: null,
            updatedAt: new Date(LOADED_AT),
          }),
          data: expect.objectContaining({ updaterId: 'usr_9' }),
        }),
      );
    });

    it('refuses a CONTRIBUTOR editing a published entry (FORBIDDEN), without writing', async () => {
      entry.findFirst.mockResolvedValueOnce({ isPublished: true } as never);

      const rejection = service.update(
        'ent_1',
        { nawatContent: 'x', expectedUpdatedAt: LOADED_AT },
        'usr_1',
        'CONTRIBUTOR',
        'es',
      );
      await expect(rejection).rejects.toBeInstanceOf(ForbiddenException);
      await rejection.catch((error: { getResponse(): { code: string } }) => {
        expect(error.getResponse()).toMatchObject({ code: 'FORBIDDEN' });
      });
      expect(entry.updateMany).not.toHaveBeenCalled();
    });

    it('409s EDIT_CONFLICT when the row moved since the caller loaded it', async () => {
      // The read passes — the row exists and is editable — and the conditional
      // update still matches nothing, which can only mean updatedAt moved. The
      // follow-up read confirms the row is still there, so this is a conflict
      // rather than a deletion.
      entry.findFirst
        .mockResolvedValueOnce({ isPublished: false } as never) // gate check
        .mockResolvedValueOnce({ id: 'ent_1' } as never); // still there?
      entry.updateMany.mockResolvedValue({ count: 0 } as never);

      const rejection = service.update(
        'ent_1',
        { nawatContent: 'x', expectedUpdatedAt: LOADED_AT },
        'usr_9',
        'CONTRIBUTOR',
        'es',
      );

      await expect(rejection).rejects.toBeInstanceOf(ConflictException);
      await rejection.catch((error: { getResponse(): { code: string } }) => {
        expect(error.getResponse()).toMatchObject({ code: 'EDIT_CONFLICT' });
      });
    });

    it('404s instead when the row was removed rather than edited', async () => {
      entry.findFirst
        .mockResolvedValueOnce({ isPublished: false } as never)
        .mockResolvedValueOnce(null as never); // gone
      entry.updateMany.mockResolvedValue({ count: 0 } as never);

      const rejection = service.update(
        'ent_1',
        { nawatContent: 'x', expectedUpdatedAt: LOADED_AT },
        'usr_9',
        'CONTRIBUTOR',
        'es',
      );

      await expect(rejection).rejects.toBeInstanceOf(NotFoundException);
      await rejection.catch((error: { getResponse(): { code: string } }) => {
        expect(error.getResponse()).toMatchObject({ code: 'ENTRY_NOT_FOUND' });
      });
    });

    it('does not send the precondition to the database as a column', async () => {
      // expectedUpdatedAt is destructured out before the spread. Prisma would
      // reject it at the type level, but this pins the runtime shape too — a
      // stray key here would be a write to a column that does not exist.
      entry.findFirst
        .mockResolvedValueOnce({ isPublished: false } as never)
        .mockResolvedValueOnce(detailRow() as never);
      entry.updateMany.mockResolvedValue({ count: 1 } as never);

      await service.update(
        'ent_1',
        { nawatContent: 'x', expectedUpdatedAt: LOADED_AT },
        'usr_9',
        'CONTRIBUTOR',
        'es',
      );

      const call = vi.mocked(entry.updateMany).mock.calls[0]?.[0] as { data: object };
      expect(call.data).not.toHaveProperty('expectedUpdatedAt');
    });

    it('does not scope the update to the caller — any contributor may edit any entry', async () => {
      // Ownership is attribution, not permission. The published-content gate is
      // the only per-row refusal left; a contributor editing another author's
      // DRAFT is now the intended behaviour, not a hole.
      entry.findFirst
        .mockResolvedValueOnce({ isPublished: false } as never)
        .mockResolvedValueOnce(detailRow() as never);
      entry.updateMany.mockResolvedValue({ count: 1 } as never);

      await service.update(
        'ent_1',
        { nawatContent: 'x', expectedUpdatedAt: LOADED_AT },
        'usr_1',
        'CONTRIBUTOR',
        'es',
      );

      expect(vi.mocked(entry.findFirst).mock.calls[0]?.[0]?.where).not.toHaveProperty('creatorId');
      const updateWhere = vi.mocked(entry.updateMany).mock.calls[0]?.[0]?.where;
      expect(updateWhere).not.toHaveProperty('creatorId');
      // The optimistic lock survives the change — it was never the ownership check.
      expect(updateWhere).toMatchObject({ updatedAt: new Date(LOADED_AT) });
    });

    it('lets an ADMIN edit a published entry', async () => {
      entry.findFirst
        .mockResolvedValueOnce({ isPublished: true } as never)
        .mockResolvedValueOnce(detailRow() as never);
      entry.updateMany.mockResolvedValue({ count: 1 } as never);

      const result = await service.update(
        'ent_1',
        { nawatContent: 'x', expectedUpdatedAt: LOADED_AT },
        'adm_1',
        'ADMIN',
        'es',
      );

      DictionaryEntryDetailSchema.strict().parse(result);
      expect(entry.updateMany).toHaveBeenCalled();
    });

    it('404s ENTRY_NOT_FOUND when no live row matches, without writing', async () => {
      entry.findFirst.mockResolvedValueOnce(null as never);

      const rejection = service.update(
        'nope',
        { nawatContent: 'x', expectedUpdatedAt: LOADED_AT },
        'usr_1',
        'CONTRIBUTOR',
        'es',
      );
      await expect(rejection).rejects.toBeInstanceOf(NotFoundException);
      await rejection.catch((error: { getResponse(): { code: string } }) => {
        expect(error.getResponse()).toMatchObject({ code: 'ENTRY_NOT_FOUND' });
      });
      expect(entry.updateMany).not.toHaveBeenCalled();
    });

    it('maps a duplicate nawatContent to CONFLICT', async () => {
      entry.findFirst.mockResolvedValueOnce({ isPublished: false } as never);
      entry.updateMany.mockRejectedValue({ code: 'P2002' } as never);

      const rejection = service.update(
        'ent_1',
        { nawatContent: 'dupe', expectedUpdatedAt: LOADED_AT },
        'usr_1',
        'CONTRIBUTOR',
        'es',
      );
      await expect(rejection).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('createFull', () => {
    const fullInput = (translations: Array<Record<string, unknown>>) => ({
      nawatContent: 'takat',
      type: 'WORD' as const,
      translations: translations as never,
    });

    it('nests the translations, each attributed to the caller', async () => {
      entry.create.mockResolvedValue(detailRow() as never);

      await service.createFull(
        fullInput([
          { dialectCode: 'common', contentEs: 'a' },
          { dialectCode: 'izalco', contentEs: 'b' },
        ]),
        'usr_1',
        'es',
      );

      expect(entry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            creatorId: 'usr_1',
            updaterId: 'usr_1',
            translations: {
              create: [
                expect.objectContaining({
                  dialectCode: 'common',
                  creatorId: 'usr_1',
                  updaterId: 'usr_1',
                }),
                expect.objectContaining({ dialectCode: 'izalco', creatorId: 'usr_1' }),
              ],
            },
          }),
        }),
      );
    });

    it('returns the created entry in the detail shape', async () => {
      entry.create.mockResolvedValue(detailRow() as never);

      const result = await service.createFull(
        fullInput([{ dialectCode: 'common', contentEs: 'a' }]),
        'usr_1',
        'es',
      );

      DictionaryEntryDetailSchema.strict().parse(result);
      expect(result).toMatchObject({ nawatContent: 'takat', creator: { name: 'Victor' } });
    });

    it('maps a unique violation (duplicate headword or repeated dialect) to CONFLICT', async () => {
      entry.create.mockRejectedValue({ code: 'P2002' } as never);

      const rejection = service.createFull(
        fullInput([{ dialectCode: 'common', contentEs: 'a' }]),
        'usr_1',
        'es',
      );
      await expect(rejection).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps an unknown dialect (FK failure) to DIALECT_NOT_FOUND', async () => {
      entry.create.mockRejectedValue({ code: 'P2003' } as never);

      const rejection = service.createFull(
        fullInput([{ dialectCode: 'nope', contentEs: 'a' }]),
        'usr_1',
        'es',
      );
      await expect(rejection).rejects.toBeInstanceOf(NotFoundException);
      await rejection.catch((error: { getResponse(): { code: string } }) => {
        expect(error.getResponse()).toMatchObject({ code: 'DIALECT_NOT_FOUND' });
      });
    });
  });

  describe('publish', () => {
    it('publishes the entry and its draft translations, returning the detail shape', async () => {
      entry.updateMany.mockResolvedValue({ count: 1 } as never);
      translationTable.updateMany.mockResolvedValue({ count: 2 } as never);
      entry.findFirst.mockResolvedValue(detailRow() as never);

      const result = await service.publish('ent_1', 'usr_9', 'es');

      DictionaryEntryDetailSchema.strict().parse(result);
      expect(entry.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ent_1', deletedAt: null },
          data: expect.objectContaining({ isPublished: true, updaterId: 'usr_9' }),
        }),
      );
      // Cascades to the entry's own draft translations only.
      expect(translationTable.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { entryId: 'ent_1', deletedAt: null, isPublished: false },
          data: expect.objectContaining({ isPublished: true, updaterId: 'usr_9' }),
        }),
      );
    });

    it('404s ENTRY_NOT_FOUND when no live row matches, cascading to nothing', async () => {
      entry.updateMany.mockResolvedValue({ count: 0 } as never);

      const rejection = service.publish('nope', 'usr_1', 'es');
      await expect(rejection).rejects.toBeInstanceOf(NotFoundException);
      await rejection.catch((error: { getResponse(): { code: string } }) => {
        expect(error.getResponse()).toMatchObject({ code: 'ENTRY_NOT_FOUND' });
      });
      expect(translationTable.updateMany).not.toHaveBeenCalled();
      expect(entry.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('unpublish', () => {
    it('returns the entry to draft and demotes its published translations', async () => {
      entry.updateMany.mockResolvedValue({ count: 1 } as never);
      translationTable.updateMany.mockResolvedValue({ count: 2 } as never);
      entry.findFirst.mockResolvedValue(detailRow() as never);

      const result = await service.unpublish('ent_1', 'usr_9', 'es');

      DictionaryEntryDetailSchema.strict().parse(result);
      expect(entry.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ent_1', deletedAt: null },
          data: expect.objectContaining({ isPublished: false, updaterId: 'usr_9' }),
        }),
      );
      // The exact mirror of publish's cascade: that one matches drafts, this one
      // matches published rows, so neither re-stamps what is already correct.
      expect(translationTable.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { entryId: 'ent_1', deletedAt: null, isPublished: true },
          data: expect.objectContaining({ isPublished: false, updaterId: 'usr_9' }),
        }),
      );
    });

    it('404s ENTRY_NOT_FOUND when no live row matches, cascading to nothing', async () => {
      entry.updateMany.mockResolvedValue({ count: 0 } as never);

      const rejection = service.unpublish('nope', 'usr_1', 'es');
      await expect(rejection).rejects.toBeInstanceOf(NotFoundException);
      await rejection.catch((error: { getResponse(): { code: string } }) => {
        expect(error.getResponse()).toMatchObject({ code: 'ENTRY_NOT_FOUND' });
      });
      expect(translationTable.updateMany).not.toHaveBeenCalled();
      expect(entry.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    // A translation.findMany row as the cascade selects it: id, isPublished, and
    // the _count of Restrict children.
    const ref = (id: string, isPublished: boolean, counts: Record<string, number> = {}) => ({
      id,
      isPublished,
      _count: {
        flashcards: 0,
        lessonVocabulary: 0,
        exerciseTranslations: 0,
        userCardProgress: 0,
        ...counts,
      },
    });

    it('soft-deletes a published entry and its published translations', async () => {
      entry.findFirst.mockResolvedValue({ isPublished: true } as never);
      translationTable.findMany.mockResolvedValue([ref('tra_1', true)] as never);

      await service.delete('ent_1', 'usr_1');

      expect(translationTable.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['tra_1'] } },
          data: expect.objectContaining({ deletedAt: expect.any(Date), updaterId: 'usr_1' }),
        }),
      );
      expect(entry.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'ent_1' } }),
      );
      expect(translationTable.deleteMany).not.toHaveBeenCalled();
      expect(entry.delete).not.toHaveBeenCalled();
    });

    it('hard-deletes a draft entry and its draft translations', async () => {
      entry.findFirst.mockResolvedValue({ isPublished: false } as never);
      translationTable.findMany.mockResolvedValue([ref('tra_1', false)] as never);

      await service.delete('ent_1', 'usr_1');

      expect(translationTable.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['tra_1'] } },
      });
      expect(entry.delete).toHaveBeenCalledWith({ where: { id: 'ent_1' } });
      expect(translationTable.updateMany).not.toHaveBeenCalled();
      expect(entry.update).not.toHaveBeenCalled();
    });

    it('409s TRANSLATION_IN_USE and removes nothing when a translation is referenced', async () => {
      entry.findFirst.mockResolvedValue({ isPublished: true } as never);
      translationTable.findMany.mockResolvedValue([
        ref('tra_1', true, { exerciseTranslations: 2 }),
      ] as never);

      const rejection = service.delete('ent_1', 'usr_1');
      await expect(rejection).rejects.toBeInstanceOf(ConflictException);
      await rejection.catch((error: { getResponse(): { code: string } }) => {
        expect(error.getResponse()).toMatchObject({ code: 'TRANSLATION_IN_USE' });
      });
      expect(translationTable.updateMany).not.toHaveBeenCalled();
      expect(translationTable.deleteMany).not.toHaveBeenCalled();
      expect(entry.update).not.toHaveBeenCalled();
      expect(entry.delete).not.toHaveBeenCalled();
    });

    it('hard-deletes an entry with no translations', async () => {
      entry.findFirst.mockResolvedValue({ isPublished: false } as never);
      translationTable.findMany.mockResolvedValue([] as never);

      await service.delete('ent_1', 'usr_1');

      expect(entry.delete).toHaveBeenCalledWith({ where: { id: 'ent_1' } });
      expect(translationTable.updateMany).not.toHaveBeenCalled();
      expect(translationTable.deleteMany).not.toHaveBeenCalled();
    });

    it('404s ENTRY_NOT_FOUND when no live row matches', async () => {
      entry.findFirst.mockResolvedValue(null as never);

      const rejection = service.delete('nope', 'usr_1');
      await expect(rejection).rejects.toBeInstanceOf(NotFoundException);
      await rejection.catch((error: { getResponse(): { code: string } }) => {
        expect(error.getResponse()).toMatchObject({ code: 'ENTRY_NOT_FOUND' });
      });
    });
  });
});

describe('dictionary type params', () => {
  // The service fences results to the WORD/EXPRESSION subset, but that fence is
  // only load-bearing because the query params refuse PHRASE at the boundary —
  // a PHRASE ?type= would otherwise select lesson content straight through.
  it('reject PHRASE and accept the WORD/EXPRESSION subset', () => {
    expect(
      DictionaryBrowseParamsSchema.safeParse({ page: 1, limit: 20, type: 'PHRASE' }).success,
    ).toBe(false);
    expect(
      DictionaryBrowseParamsSchema.safeParse({ page: 1, limit: 20, type: 'EXPRESSION' }).success,
    ).toBe(true);

    expect(
      DictionarySearchParamsSchema.safeParse({ q: 'ne', page: 1, limit: 20, type: 'PHRASE' })
        .success,
    ).toBe(false);
    expect(
      DictionarySearchParamsSchema.safeParse({ q: 'ne', page: 1, limit: 20, type: 'EXPRESSION' })
        .success,
    ).toBe(true);
  });
});
