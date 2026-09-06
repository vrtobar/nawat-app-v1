import { z } from 'zod';

// =============================================================================
// UNIFORM API RESPONSE ENVELOPE
// Applied to all NestJS endpoints via a global interceptor.
//
// correlationId policy:
//   X-Correlation-ID header — present on ALL responses, success and error
//   Response body           — correlationId only on ERROR responses.
// =============================================================================

// -----------------------------------------------------------------------------
// PAGINATION
// PaginationParamsSchema — shared query params, extended by list endpoints.
// PaginationMetaSchema   — returned alongside data on all paginated lists.
// totalPages derived from total / limit — computed in NestJS service.
// -----------------------------------------------------------------------------

export const PaginationParamsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const PaginationMetaSchema = z.object({
  total: z.number().int(), // total matching records
  page: z.number().int(), // current page (1-indexed)
  limit: z.number().int(), // records per page
  totalPages: z.number().int(), // Math.ceil(total / limit)
});

export type PaginationParams = z.infer<typeof PaginationParamsSchema>;
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

// -----------------------------------------------------------------------------
// SUCCESS RESPONSES
// -----------------------------------------------------------------------------

// Single item or action result
export const ApiSuccessSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
  });

// Paginated list
export const ApiPaginatedSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.object({
    success: z.literal(true),
    data: z.array(itemSchema),
    meta: PaginationMetaSchema,
  });

// -----------------------------------------------------------------------------
// ERROR RESPONSE
// code          — machine-readable, used by frontend to handle specific errors
// message       — human-readable, safe to display to the user
// correlationId — support-reportable request ID (also in X-Correlation-ID header)
// details       — optional field-level validation errors from ZodValidationPipe
// -----------------------------------------------------------------------------

export const ApiErrorDetailSchema = z.object({
  field: z.string().optional(), // field path e.g. "body.nawatContent"
  message: z.string(),
});

export const ApiErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    correlationId: z.string(),
    details: z.array(ApiErrorDetailSchema).optional(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiErrorDetail = z.infer<typeof ApiErrorDetailSchema>;

// -----------------------------------------------------------------------------
// HELPER TYPES
// Typed wrappers for use in NestJS service return types and Next.js fetch utils.
// -----------------------------------------------------------------------------

export type ApiSuccess<T> = { success: true; data: T };
export type ApiPaginated<T> = { success: true; data: T[]; meta: PaginationMeta };
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// -----------------------------------------------------------------------------
// OPTIMISTIC LOCK
//
// The `updatedAt` the client last read, sent back with the write it wants to
// perform. The service makes the update conditional on it, so a row that moved
// in between is refused (EDIT_CONFLICT) instead of overwritten.
//
// WHY THIS IS NEEDED AT ALL, since it looks like ceremony on a small project:
// the editor sends EVERY field on every save, not a diff. So a save does not
// merely overwrite what its author changed — it overwrites every field with
// whatever that author's form last loaded. Two people on one translation is
// then not a near-miss but a silent deletion: A opens a card, B adds an English
// gloss and saves, A saves an unrelated fix, and B's gloss is written back to
// null with no error anywhere.
//
// `updatedAt` rather than a version column because it already exists, already
// moves on every write (Prisma @updatedAt), and is already returned by the
// admin read shapes — so nothing needs a migration. It works as a version token
// because the columns are `timestamp(3)`: millisecond precision, exactly what an
// ISO-8601 string carries, so the round trip is lossless. A `timestamp(6)`
// column would silently truncate and never match, which is why the precision is
// stated here rather than assumed.
//
// REQUIRED, not optional. A precondition a client can omit is a precondition
// that defaults to off, which is the behaviour being fixed.
// -----------------------------------------------------------------------------

export const OptimisticLockSchema = z.iso.datetime();

// -----------------------------------------------------------------------------
// ERROR CODE CONSTANTS
// -----------------------------------------------------------------------------

export const API_ERROR_CODES = {
  // Generic
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  // A write whose precondition no longer holds: the row moved between the read
  // that populated the form and the write that submits it. Distinct from
  // CONFLICT, which covers uniqueness collisions — this one is recoverable by
  // reloading, and the client is expected to say so rather than retry blindly.
  EDIT_CONFLICT: 'EDIT_CONFLICT',
  RESTRICT_VIOLATION: 'RESTRICT_VIOLATION',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // Dictionary
  //
  // ENTRY_HAS_TRANSLATIONS was removed here: the entry delete became a
  // transactional cascade rather than require-empty, so nothing raises it. A
  // code that is published and never thrown reads as contract — the next
  // reader asks when a delete returns it, and the answer is never.
  ENTRY_NOT_FOUND: 'ENTRY_NOT_FOUND',
  ENTRY_SLUG_CONFLICT: 'ENTRY_SLUG_CONFLICT',
  TRANSLATION_NOT_FOUND: 'TRANSLATION_NOT_FOUND',
  TRANSLATION_IN_USE: 'TRANSLATION_IN_USE',
  DIALECT_NOT_FOUND: 'DIALECT_NOT_FOUND',
  DIALECT_IN_USE: 'DIALECT_IN_USE',

  // Content — Level > Course > Unit > Lesson > Exercise
  LEVEL_NOT_FOUND: 'LEVEL_NOT_FOUND',
  COURSE_NOT_FOUND: 'COURSE_NOT_FOUND',
  COURSE_NOT_PUBLISHABLE: 'COURSE_NOT_PUBLISHABLE',
  UNIT_NOT_FOUND: 'UNIT_NOT_FOUND',
  UNIT_NOT_PUBLISHABLE: 'UNIT_NOT_PUBLISHABLE',
  LESSON_NOT_FOUND: 'LESSON_NOT_FOUND',
  LESSON_LOCKED: 'LESSON_LOCKED',
  LESSON_NOT_PUBLISHABLE: 'LESSON_NOT_PUBLISHABLE',
  EXERCISE_NOT_FOUND: 'EXERCISE_NOT_FOUND',
  EXERCISE_INVALID_CONFIG: 'EXERCISE_INVALID_CONFIG',
  EXERCISE_INVALID_ROLES: 'EXERCISE_INVALID_ROLES',
  EXERCISE_MISSING_AUDIO: 'EXERCISE_MISSING_AUDIO',
  EXERCISE_MISSING_IMAGE: 'EXERCISE_MISSING_IMAGE',

  // Media
  MEDIA_ASSET_NOT_FOUND: 'MEDIA_ASSET_NOT_FOUND',
  // The declared content type is not one the pipeline has a branch for. Raised
  // at presign rather than after a queue round trip, so an unsupported format
  // is a 400 at the boundary instead of a FAILED asset a reviewer has to
  // interpret.
  MEDIA_TYPE_UNSUPPORTED: 'MEDIA_TYPE_UNSUPPORTED',
  // Too many uploads presigned and never completed. A presigned URL is a write
  // capability, and this bounds how many one user may hold at once.
  UPLOAD_LIMIT_REACHED: 'UPLOAD_LIMIT_REACHED',
  // A transition the asset's current status does not allow — completing an
  // upload twice, or completing one that already failed. Named rather than a
  // bare CONFLICT because the client's recovery differs per state, and the
  // message says which state it was in.
  MEDIA_INVALID_STATE: 'MEDIA_INVALID_STATE',
  // The upload was reported complete, but the object is not in the bucket or
  // does not match what was signed. The asset stays AWAITING_UPLOAD, so the
  // caller can retry the PUT rather than start over.
  MEDIA_UPLOAD_INCOMPLETE: 'MEDIA_UPLOAD_INCOMPLETE',
  // An AUDIO asset offered to an entry's image slot, or the reverse. A
  // translation carries a recording and an entry carries a picture; the kind is
  // fixed at upload and the slot cannot coerce it.
  MEDIA_KIND_MISMATCH: 'MEDIA_KIND_MISMATCH',
  // The asset is already attached to a different entry or translation. One
  // asset serves one row — the same recording used twice would give two rows a
  // single approval state and a single set of derivatives, so a second use is
  // a second upload.
  MEDIA_ALREADY_ATTACHED: 'MEDIA_ALREADY_ATTACHED',
  // Publishing an asset attached to nothing. Approval writes a URL onto a
  // parent row, so an unattached asset has nowhere for that URL to go.
  MEDIA_NOT_ATTACHED: 'MEDIA_NOT_ATTACHED',
  // The asset says READY but its derivatives are missing, unparseable, or name
  // a primary file that is not in the list. Points at the processor rather than
  // at the upload, which is why it is not MEDIA_UPLOAD_INCOMPLETE.
  MEDIA_DERIVATIVES_INVALID: 'MEDIA_DERIVATIVES_INVALID',

  // Flashcards
  FLASHCARD_SET_NOT_FOUND: 'FLASHCARD_SET_NOT_FOUND',
  FLASHCARD_ALREADY_IN_SET: 'FLASHCARD_ALREADY_IN_SET',

  // Auth / users
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_DEACTIVATED: 'USER_DEACTIVATED',
  // A Google subject presenting an email address that already belongs to
  // another row. Rarer with one provider than it was with two — the Auth0-era
  // case was one person signing in with Google and with an email code,
  // producing two subjects for one human — but not impossible: a Workspace
  // address can be deleted and reissued to a new account, which carries a new
  // `sub`. Identity is keyed on googleId, and email holds its own unique
  // constraint, so the two rows cannot coexist.
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  // A verified token whose subject has no account. Since 2026-08-25 accounts
  // are created at login by POST /auth/session and nowhere else, so this means
  // the session was established without that call completing — or the row was
  // hard-deleted while the token was still valid. Distinct from UNAUTHORIZED
  // because the remedy differs: the credential is fine, the account is absent,
  // and signing in again is what fixes it.
  ACCOUNT_NOT_PROVISIONED: 'ACCOUNT_NOT_PROVISIONED',
  // The ID token presented to POST /auth/session did not verify against
  // Google: bad signature, wrong `aud` or `iss`, or expired. Distinct from
  // UNAUTHORIZED because it names WHOSE credential failed — an access token
  // this API minted, or an assertion Google did — and those have different
  // remedies. Deliberately not subdivided further: telling a caller which of
  // the four checks failed helps whoever is probing the endpoint more than it
  // helps the one legitimate caller, which is this project's own web tier.
  INVALID_GOOGLE_TOKEN: 'INVALID_GOOGLE_TOKEN',
  // Google authenticated the person but reports `email_verified: false`. Rare
  // for a consumer account and possible for a Workspace one. Refused rather
  // than provisioned, because `users.email` is unique and unverified addresses
  // are how one person claims another's row.
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  // A refresh token that is unknown, expired, revoked, or already spent.
  //
  // ONE CODE FOR ALL FOUR, and the reuse case is the reason. Rotation means a
  // token presented twice is either an attacker replaying a stolen one or the
  // legitimate holder racing itself, and the response revokes the whole family
  // either way. Reporting reuse distinctly would confirm to whoever presented
  // it that the theft was noticed, which is information worth exactly as much
  // to an attacker as it is to the user — and the user's remedy is the same for
  // all four: sign in again. The distinction is kept where it is useful, in the
  // log, with the family id.
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];
