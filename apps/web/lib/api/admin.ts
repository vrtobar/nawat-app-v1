import {
  AdminEntryDetailSchema,
  AdminEntryListItemSchema,
  type AdminEntryStatus,
  type CreateFullEntry,
  type CreateTranslation,
  DictionaryEntryDetailSchema,
  TranslationDetailSchema,
  type UpdateEntry,
  type UpdateTranslation,
  UserProfileSchema,
} from '@nahuat/shared';
import { cache } from 'react';

import { authedItem, authedPage, mutate } from './client';

// GET /users/me — the signed-in user's own profile.
//
// This is where the panel learns its own role, and it is the authoritative
// place to learn it. The access token carries no role claim: the API resolves
// role from the user row on every request (ADR 13, "Reversal: identity is
// resolved per request"), and this endpoint reads that same row. So what the
// panel shows and what the API will permit cannot disagree — a promotion is
// visible here on the next request, with no new token and no re-login.
// MEMOISED PER REQUEST, not cached across them. Two Server Components read the
// role on an admin page render — the layout, to gate the shell, and the entries
// page, to decide whether a publish button exists — which was two HTTP round
// trips to the API for one row on every render.
//
// React's own `fetch` dedup does not cover it: `authedItem` sends
// `cache: 'no-store'`, which opts out of the cache dedup relies on. Removing
// that is not an option — the response varies by user and must never be shared
// between requests — so the memoisation goes here instead, where `cache()`
// scopes it to a single render pass and it expires with the request.
//
// The result: still fresh per request, so a role change is visible on the next
// one exactly as before, and ADR 13's per-request resolution is unaffected.
export const getMe = cache(() => authedItem('/users/me', UserProfileSchema));

// GET /admin/entries — entries including drafts, which no public read returns.
//
// UNSCOPED for every CONTRIBUTOR+ caller: ownership is attribution, not
// permission, so anyone who may edit an entry may list it. `mine` narrows to
// the caller's own authorship by choice — see the API's ./ownership for why it
// counts creation and not edits.
export function listAdminEntries(
  params: { status?: AdminEntryStatus; page?: number; mine?: boolean } = {},
) {
  return authedPage('/admin/entries', AdminEntryListItemSchema, {
    status: params.status,
    page: params.page,
    // Omitted rather than sent as false when off: the API parses it with
    // z.stringbool(), and an absent key is the clearer "no filter".
    mine: params.mine ? true : undefined,
  });
}

// PATCH /entries/:id/publish — ADMIN. Publishes the entry and cascades to its
// draft translations. Returns the entry detail, which this discards: the caller
// revalidates the list rather than reconciling one row into it.
export function publishEntry(id: string) {
  return mutate(`/entries/${encodeURIComponent(id)}/publish`, { method: 'PATCH' });
}

// PATCH /entries/:id/unpublish — ADMIN. Returns the entry to draft, cascading
// to its published translations. The correction path for a mistake that went
// live: before this route existed the only way back was deleting the row, which
// costs its id, slug and attribution over what is usually a wrong gloss.
export function unpublishEntry(id: string) {
  return mutate(`/entries/${encodeURIComponent(id)}/unpublish`, { method: 'PATCH' });
}

// GET /admin/entries/:id — the entry behind the editor, CONTRIBUTOR+.
//
// Content comes back UNRESOLVED: contentEs and contentEn side by side, under
// the same field names CreateTranslationSchema uses. That is what lets the form
// PATCH back exactly what it received with no mapping layer in between, and it
// is why this endpoint exists rather than the public detail being reused.
//
// A row belonging to another author 404s rather than 403s — the API refuses to
// be an existence oracle — so the caller maps ENTRY_NOT_FOUND to notFound()
// and cannot distinguish the two cases. That is deliberate.
export function getAdminEntry(id: string) {
  return authedItem(`/admin/entries/${encodeURIComponent(id)}`, AdminEntryDetailSchema);
}

// POST /entries/full — a new entry and all its translations in one transaction.
//
// Used rather than POST /entries because an entry with no translations renders
// nowhere: the public reads filter out rows with nothing to show, so a bare
// entry would be created and then be invisible until a second request. The
// schema requires at least one translation for the same reason.
//
// THE RESPONSE IS NOT THE NEW STATE. It is resolved to the caller's locale
// (@ContentLocale), and the write projection drops translations lacking content
// in that locale — so creating a Spanish-only entry as a contributor whose
// locale is English returns an empty translations array. Only `id` is read from
// it here, which no resolution affects.
export function createFullEntry(body: CreateFullEntry) {
  return mutate('/entries/full', {
    method: 'POST',
    body,
    schema: DictionaryEntryDetailSchema,
  });
}

// PATCH /entries/:id — the headword, type and image. Not the translations:
// there is no whole-entry update, which is why the editor saves per section.
// The response is discarded and the page revalidated instead, for the
// resolution reason described on createFullEntry.
export function updateEntry(id: string, body: UpdateEntry) {
  // Parsed now, where it used to be discarded, for one field: the new
  // `updatedAt`. The form holds the value it loaded as its optimistic lock, so
  // without refreshing it after a save the SECOND save of the same session
  // would present a stale token and be refused as a conflict against itself.
  return mutate(`/entries/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    schema: DictionaryEntryDetailSchema,
  });
}

// POST /entries/:entryId/translations — adds a dialect to an existing entry.
// dialectCode lives in the body and is fixed at creation; a dialect the entry
// already carries collides on the unique constraint, so the caller offers only
// the ones it does not have yet.
export function createTranslation(entryId: string, body: CreateTranslation) {
  return mutate(`/entries/${encodeURIComponent(entryId)}/translations`, {
    method: 'POST',
    body,
  });
}

// PATCH /translations/:id — one translation. dialectCode is absent from
// UpdateTranslationSchema because a dialect is immutable after creation: the
// editor renders that select disabled rather than sending a value the API
// would ignore.
export function updateTranslation(id: string, body: UpdateTranslation) {
  // Parsed for the refreshed `updatedAt` — see updateEntry.
  return mutate(`/translations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    schema: TranslationDetailSchema,
  });
}

// DELETE /translations/:id — ADMIN. Granular on purpose: publishing is
// entry-level, but removing one wrong translation without touching the rest is
// a real need.
export function deleteTranslation(id: string) {
  return mutate(`/translations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
