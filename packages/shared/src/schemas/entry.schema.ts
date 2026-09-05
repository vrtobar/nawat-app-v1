import { z } from 'zod';

import { OptimisticLockSchema, PaginationParamsSchema } from './api-response.schema';
import { LocaleSchema } from './locale.schema';
import { MediaStatusSchema } from './media.schema';
import {
  AdminTranslationDetailSchema,
  CreateTranslationSchema,
  PartOfSpeechSchema,
  TranslationDetailSchema,
} from './translation.schema';

// -----------------------------------------------------------------------------
// ENUMS
// -----------------------------------------------------------------------------

// WORD and EXPRESSION are dictionary headwords — a single word vs. a multi-word
// lexical unit (idiom, fixed/common expression, collocation). PHRASE is a full
// teaching utterance that lives in lessons, not the dictionary browse; the
// public dictionary reads restrict to WORD/EXPRESSION.
export const EntryTypeSchema = z.enum(['WORD', 'EXPRESSION', 'PHRASE']);
export type EntryType = z.infer<typeof EntryTypeSchema>;

// The dictionary-visible subset. PHRASE is lesson content, so the public browse
// and search neither accept it as a ?type= filter nor return it. Derived from
// EntryTypeSchema with .exclude so it tracks the enum as it grows;
// DICTIONARY_ENTRY_TYPES feeds the service's baseline `type IN (...)` fence.
export const DictionaryEntryTypeSchema = EntryTypeSchema.exclude(['PHRASE']);
export type DictionaryEntryType = z.infer<typeof DictionaryEntryTypeSchema>;
export const DICTIONARY_ENTRY_TYPES = DictionaryEntryTypeSchema.options;

// -----------------------------------------------------------------------------
// PRIMARY TRANSLATION INLINE
// Lean shape embedded in list items — just enough to render a dictionary row
// with its meaning, audio button, and part of speech badge. Full translation
// data available in DictionaryEntryDetail.
//
// Which translation this is depends on the request. Default browse shows the
// whole dictionary and picks a representative form per entry: the one whose
// dialect has the lowest precedence (Dialect.precedence — `common` is 0, so the
// broadly-used form wins when present), otherwise the highest-precedence dialect
// the entry does have — so a word attested only in, say, Izalco still appears,
// labelled with its dialect rather than hidden for lacking a common form. A
// `?dialectCode=` filter narrows to that dialect. `dialectCode` on this shape
// names which it turned out to be. A dialect has at most one translation per
// entry, so there is no within-dialect tiebreak; precedence is the whole order.
//
// `content` is resolved to one locale server-side (ADR 0015 §4), never both
// languages — see TranslationDetailSchema for the reasoning. Non-null because
// entries with no renderable translation in the resolved locale are filtered
// out of the list — only reachable for English, since Spanish content is
// mandatory on every translation. `locale` echoes which language was served.
// -----------------------------------------------------------------------------

const PrimaryTranslationSchema = z.object({
  id: z.string(),
  content: z.string(),
  locale: LocaleSchema,
  partOfSpeech: PartOfSpeechSchema.nullable(),
  audioUrl: z.url().nullable(),
  phonetic: z.string().nullable(),
  dialectCode: z.string(),
});

// -----------------------------------------------------------------------------
// IMAGE RENDITIONS
// -----------------------------------------------------------------------------

// One produced size of an entry's approved image. The set of these is what lets
// a reader build a srcset and reserve a box before the bytes arrive.
//
// THE CLIENT CANNOT DERIVE THIS, which is why it is on the wire at all. The
// processor never upscales, so which widths exist depends on the source: an
// 800px original yields 320/640/800 and no 960, while a phone photo yields
// 320/640/960 and no 800. A hardcoded srcset would request an object that does
// not exist for one of those two. Only the server knows what was produced.
//
// `height` is carried per rendition rather than as one aspect ratio because it
// is the resized pixel height — recomputing it from a ratio would round a
// second time and could disagree by a pixel, which is a layout shift on the
// page this exists to stop shifting.
export const ImageRenditionSchema = z.object({
  width: z.int().positive(),
  height: z.int().positive(),
  url: z.url(),
});

export type ImageRendition = z.infer<typeof ImageRenditionSchema>;

// -----------------------------------------------------------------------------
// LIST ITEM
// Used on:
//   - Public dictionary search page (/dictionary)
//   - Admin dictionary table
//   - Exercise builder (picking entries for exercises)
//   - Flashcard set builder
//
// Paginated responses use the generic envelope:
//   ApiPaginated<DictionaryEntryListItem>
// imageUrl included for IMAGE_SELECT exercise preview in admin.
// -----------------------------------------------------------------------------

export const DictionaryEntryListItemSchema = z.object({
  id: z.string(),
  type: EntryTypeSchema,
  nawatContent: z.string(),
  slug: z.string(), // canonical URL identifier — /dictionary/[slug]
  imageUrl: z.url().nullable(),
  isPublished: z.boolean(),
  primaryTranslation: PrimaryTranslationSchema,
  createdAt: z.iso.datetime(),
});

export type DictionaryEntryListItem = z.infer<typeof DictionaryEntryListItemSchema>;

// -----------------------------------------------------------------------------
// DETAIL
// Used on:
//   - Public dictionary entry page (/dictionary/[entryId])
//   - Admin entry edit form
//
// All translations included, ordered by dialect precedence ascending.
// Creator name included for attribution display — id excluded (internal).
// -----------------------------------------------------------------------------

export const DictionaryEntryDetailSchema = z.object({
  id: z.string(),
  type: EntryTypeSchema,
  nawatContent: z.string(),
  slug: z.string(), // canonical URL identifier — /dictionary/[slug]
  imageUrl: z.url().nullable(),
  // The ladder behind `imageUrl`, narrowest first. ADDITIVE: `imageUrl` remains
  // the primary and remains the only thing a client must understand, so a
  // caller that ignores this keeps working unchanged.
  //
  // Null, never partial. An entry approved before the processor recorded
  // heights has a URL and no ladder, and a reader with no ladder falls back to
  // the single `imageUrl` — which is what every reader did before this field.
  imageRenditions: z.array(ImageRenditionSchema).nullable(),
  isPublished: z.boolean(),
  creator: z.object({
    name: z.string(),
  }),
  translations: z.array(TranslationDetailSchema), // ordered by dialect precedence asc
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type DictionaryEntryDetail = z.infer<typeof DictionaryEntryDetailSchema>;

// -----------------------------------------------------------------------------
// QUERY PARAMS
// Two endpoints, two contracts (see api-reference.md). Routes are flat — no
// module prefix (ADR 0008):
//   GET /entries        — structured browsing, no fuzzy search
//   GET /entries/search — pg_trgm fuzzy search, q required
//
// isPublished uses z.stringbool() — z.coerce.boolean() would turn the query
// string "false" into true (Boolean('false') === true). CONTRIBUTOR+ only;
// service ignores it for public/USER requests.
// -----------------------------------------------------------------------------

export const DictionaryBrowseParamsSchema = PaginationParamsSchema.extend({
  type: DictionaryEntryTypeSchema.optional(),
  partOfSpeech: PartOfSpeechSchema.optional(),
  dialectCode: z.string().optional(),
  isPublished: z.stringbool().optional(),
});

export const DictionarySearchParamsSchema = PaginationParamsSchema.extend({
  q: z.string().min(1), // required — endpoint 400s without it
  type: DictionaryEntryTypeSchema.optional(),
  dialectCode: z.string().optional(),
});

export type DictionaryBrowseParams = z.infer<typeof DictionaryBrowseParamsSchema>;
export type DictionarySearchParams = z.infer<typeof DictionarySearchParamsSchema>;

// -----------------------------------------------------------------------------
// CREATE / UPDATE DTOs
// Translations are created separately via /translations endpoint
// (or atomically via POST /entries/full).
//
// NEITHER SHAPE CARRIES imageUrl. The column is written by exactly one thing,
// an ADMIN approving a MediaAsset (docs/adr/0020); an image is attached to an
// entry through the media sub-resource endpoints, never by sending a URL.
// -----------------------------------------------------------------------------

export const CreateEntrySchema = z.object({
  nawatContent: z.string().min(1).max(500),
  type: EntryTypeSchema.default('WORD'),
});

// PATCH — every field optional. See UpdateTranslationSchema for the full
// reasoning on absent-versus-null: an absent key means leave alone and an
// explicit null means clear (RFC 7396), because `undefined` does not survive
// JSON.stringify and so cannot express the difference on the wire. Nothing on
// an entry is clearable any more, now that imageUrl is gone — every remaining
// field can be changed but not emptied.
//
// `nawatContent` and `type` are not nullable. An entry with no headword is not
// an entry, and `type` has a default rather than an empty state — both can be
// changed, neither can be emptied.
//
// `type` IS UNWRAPPED FROM ITS DEFAULT, and that is a bug fix rather than
// tidying. `.partial()` makes a field optional but does not remove a
// `.default()` underneath it, so the previous `CreateEntrySchema.partial()`
// resolved a missing `type` to 'WORD' and handed it to the service's spread —
// meaning any partial update, a rename included, silently rewrote an
// EXPRESSION or a PHRASE into a WORD. Unwrapping leaves an absent `type`
// absent. The default still applies where it belongs, on create.
export const UpdateEntrySchema = CreateEntrySchema.extend({
  type: CreateEntrySchema.shape.type.unwrap(),
})
  .partial()
  .extend({ expectedUpdatedAt: OptimisticLockSchema });

// POST /entries/full — an entry and its first translations in one atomic
// request. At least one translation: a full create with none is just POST
// /entries, and this path exists precisely to seed an entry with content in a
// single call. Each translation is a distinct dialect (one per dialect per
// entry); two sharing a dialectCode collide on the unique constraint.
export const CreateFullEntrySchema = CreateEntrySchema.extend({
  translations: z.array(CreateTranslationSchema).min(1),
});

export type CreateEntry = z.infer<typeof CreateEntrySchema>;
export type UpdateEntry = z.infer<typeof UpdateEntrySchema>;
export type CreateFullEntry = z.infer<typeof CreateFullEntrySchema>;

// =============================================================================
// ADMIN SURFACE
// Shapes for GET /admin/entries and GET /admin/entries/:id — the authenticated
// CONTRIBUTOR+ read paths that back the content-authoring panel.
//
// A separate shape set rather than a flag on the public ones, for two reasons
// that are not stylistic:
//
//   1. CONTENT IS UNRESOLVED. The public shapes resolve translations to one
//      locale (ADR 0015 §4); an editor needs both languages to prefill a form.
//      See AdminTranslationDetailSchema for the full reasoning.
//   2. THE PUBLIC READS STAY UNAUTHENTICATED. They are @Public, so no req.user
//      exists to authorize a draft view against, and giving them optional auth
//      would put a fall-through branch in front of every dictionary page —
//      the shape ADR 0013 rejects — and make a cacheable response vary by
//      token.
//
// Kept in this file beside the public shapes on purpose: the two describe the
// same resource and drift is the risk worth designing against.
// =============================================================================

// Who created or last touched a row. `id` is included here where the public
// DictionaryEntryDetail exposes only `name` — this surface is role-gated, and
// the panel needs the id to filter a contributor's own work. A CONTRIBUTOR only
// ever sees rows they created, so the only id they can observe is their own.
export const AdminActorSchema = z.object({
  id: z.string(),
  name: z.string(),
});

// -----------------------------------------------------------------------------
// ADMIN LIST ITEM
// A row in the authoring table. Deliberately NOT DictionaryEntryListItem: that
// shape carries a primaryTranslation resolved to one locale, which a draft may
// not have in the requested language at all.
//
// translationCount and hasEnglish are computed, not stored — they answer "is
// this row worth opening" without a second request per row.
//
// hasEnglish means EVERY translation carries contentEn, not merely one of them,
// and is false for an entry with no translations. It is INFORMATIONAL ONLY.
// ADR 0015 §2 exempts dictionary entries from the English-to-publish rule
// ("Entries publish with Spanish alone"), so this is a completeness hint the
// panel can surface, never a gate — the publish path does not check it.
//
// It is derived from englishCount in the service rather than computed a second
// time, so the two cannot disagree. Note what the pair is actually reporting:
// not tidiness, but VISIBILITY. §2 permits publishing with Spanish alone and §4
// resolves content to one locale, so a Spanish-only entry is published and
// simultaneously invisible to every English reader — a consequence neither ADR
// states, and the reason the panel needs to say more than "missing".
// -----------------------------------------------------------------------------

export const AdminEntryListItemSchema = z.object({
  id: z.string(),
  type: EntryTypeSchema,
  nawatContent: z.string(),
  slug: z.string(),
  imageUrl: z.url().nullable(),
  isPublished: z.boolean(),
  translationCount: z.number().int(),
  // How many of them carry contentEn. Present alongside hasEnglish because the
  // boolean cannot distinguish the two cases the panel must word differently:
  // one of three translations missing English means the entry still appears to
  // an English reader with fewer senses, while none of them missing means the
  // entry does not appear AT ALL. The public browse requires contentEn in its
  // semi-join when the locale resolves to English, so an entry with no English
  // anywhere is filtered out entirely rather than shown glossless.
  englishCount: z.number().int(),
  // Translations not yet published. Read together with isPublished, it names a
  // state the panel could not otherwise show: an entry that is LIVE while some
  // of its translations are not, which happens whenever a dialect is added to
  // an already-published entry. Those translations are excluded from the public
  // reads in every locale, so the dialect exists only in the panel.
  //
  // On a draft entry this equals translationCount and means nothing — nothing
  // is published because the entry is not. The condition worth surfacing is
  // isPublished && unpublishedTranslationCount > 0, which is the caller's to
  // apply; the count is reported raw for the same reason englishCount is.
  unpublishedTranslationCount: z.number().int(),
  hasEnglish: z.boolean(),
  creator: AdminActorSchema,
  updater: AdminActorSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type AdminEntryListItem = z.infer<typeof AdminEntryListItemSchema>;

// -----------------------------------------------------------------------------
// ADMIN DETAIL
// Backs the entry edit form. Every translation, unresolved, including drafts.
//
// `updater` is present where the public detail has `creator` alone: on a review
// surface "who touched this last" is the question being asked, and updaterId is
// the only record of an edit until the editorial-review module exists.
// -----------------------------------------------------------------------------

export const AdminEntryDetailSchema = z.object({
  id: z.string(),
  type: EntryTypeSchema,
  nawatContent: z.string(),
  slug: z.string(),
  imageUrl: z.url().nullable(),
  // The image's place in the pipeline, on the same terms as `audioStatus` on
  // AdminTranslationDetail — see the note there for why a status is carried
  // where an asset id is not. Null when nothing is attached.
  imageStatus: MediaStatusSchema.nullable(),
  imageError: z.string().nullable(),
  // As `audioNotes` on AdminTranslationDetail — see the note there.
  imageNotes: z.string().nullable(),
  isPublished: z.boolean(),
  creator: AdminActorSchema,
  updater: AdminActorSchema,
  translations: z.array(AdminTranslationDetailSchema), // dialect precedence asc
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type AdminEntryDetail = z.infer<typeof AdminEntryDetailSchema>;

// -----------------------------------------------------------------------------
// ADMIN QUERY PARAMS
//
// `status` defaults to 'draft' — the panel's job is the queue of things not yet
// live, and that default is also the one the supporting partial index covers
// (entries_drafts_idx).
//
// `type` accepts the FULL EntryTypeSchema, not the WORD/EXPRESSION subset the
// public browse fences to. PHRASE is lesson-only for readers, but hiding rows
// from the surface that manages them is how content becomes unreachable.
//
// `q` is a plain case-insensitive substring match on nawatContent, NOT the
// trigram search GET /entries/search uses. An author knows the headword they
// are looking for; fuzzy ranking would bury an exact match under near ones, and
// the whole-string `%` operator returns nothing for the short prefixes someone
// actually types into an admin filter.
//
// No `locale` — nothing on this surface is resolved.
// -----------------------------------------------------------------------------

// 'pending-translations' is the odd one out and deliberately so: the other
// three filter on the entry's own isPublished, while this one asks about its
// translations — published entries carrying at least one translation that is
// not live, which happens whenever a dialect is added after publishing.
//
// A view of its own rather than folded into 'draft', because publishing a new
// entry and releasing a stray translation are different jobs: one is reviewing
// a whole record, the other is letting through an addition to a record already
// reviewed. Merging them would make the queue mean two things. It also cannot
// live under 'draft' without that word covering both "this entry is not live"
// and "part of this live entry is not live".
// 'missing-audio' and 'pending-translations' are both questions about
// TRANSLATIONS expressed as an entry status, because the entry is what the
// panel lists and what a person opens to act on the answer.
export const AdminEntryStatusSchema = z.enum([
  'draft',
  'pending-translations',
  'missing-audio',
  'published',
  'all',
]);
export type AdminEntryStatus = z.infer<typeof AdminEntryStatusSchema>;

export const AdminEntriesQuerySchema = PaginationParamsSchema.extend({
  status: AdminEntryStatusSchema.default('draft'),
  type: EntryTypeSchema.optional(),
  q: z.string().min(1).optional(),
  // Narrows to the caller's own work: entries they created, or that carry a
  // translation they created. An OPT-IN filter, not a scope — the reads are
  // otherwise unscoped, because any contributor may edit any entry and a read
  // narrower than the write scope would let someone edit a row they cannot
  // open.
  //
  // Authored, not touched. `updaterId` records only the last writer, so an
  // edit-based filter would drop a caller's own work out of this view as soon
  // as anyone else saved that row.
  //
  // z.stringbool() rather than z.coerce.boolean(), which turns the query string
  // "false" into true — the same reason DictionaryBrowseParamsSchema uses it.
  mine: z.stringbool().optional(),
});

export type AdminEntriesQuery = z.infer<typeof AdminEntriesQuerySchema>;
