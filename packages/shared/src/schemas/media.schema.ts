import { z } from 'zod';

// =============================================================================
// MEDIA
// Contracts for uploading audio and images. The pipeline behind them is
// docs/adr/0020: an upload becomes a MediaAsset, the asset is processed
// asynchronously, and an ADMIN approving it is what publishes a URL.
// =============================================================================

export const MediaKindSchema = z.enum(['AUDIO', 'IMAGE']);
export type MediaKind = z.infer<typeof MediaKindSchema>;

// AWAITING_UPLOAD is not in ADR 20 — see the enum comment in schema.prisma for
// why the state the row is created in is distinct from the one that means
// "queued and unprocessed".
export const MediaStatusSchema = z.enum(['AWAITING_UPLOAD', 'PENDING', 'READY', 'FAILED']);
export type MediaStatus = z.infer<typeof MediaStatusSchema>;

// -----------------------------------------------------------------------------
// WHAT MAY BE UPLOADED
// -----------------------------------------------------------------------------

// Content type -> the extension the stored object gets. THE EXTENSION IS
// DERIVED HERE, never taken from a client-supplied filename: a filename is
// attacker-controlled text, and the only thing it could add is a way for the
// stored key to disagree with the type that was signed.
//
// An allowlist rather than a pattern. `audio/*` would accept formats the
// processor has no branch for, and the failure would surface as a FAILED asset
// after a queue round trip instead of a 400 at the boundary.
export const ACCEPTED_MEDIA_TYPES = {
  AUDIO: {
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm',
    // TWO SPELLINGS OF ONE FORMAT, both mapping to m4a. Browsers disagree about
    // what an .m4a file is: `audio/mp4` is the registered type and
    // `audio/x-m4a` is what several still report. Both halves of the upload
    // path test membership of this map — the form before it presigns, the API
    // before it signs — so listing one spelling would leave the file refused
    // wherever the browser chose the other, and the refusal would look like a
    // rule about the format rather than about its name.
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
  },
  IMAGE: {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  },
} as const satisfies Record<MediaKind, Record<string, string>>;

// audio/webm is accepted alongside the three the API reference lists. IT IS NOT
// KEPT FOR THE REASON IT WAS ADDED: the original justification was that
// MediaRecorder produces it in Chrome and Firefox, and that recording in the
// browser is the shortest path from a speaker to an asset. In-browser recording
// was examined and rejected on 2026-09-02 — capture happens on a field recorder
// outside this application, because MediaRecorder's format differs by engine,
// its defaults apply noise suppression and automatic gain that damage exactly
// the consonants a documentation recording exists to preserve, and `source/` is
// kept permanently for speakers who cannot be re-recorded.
//
// m4a is here because "at worst a capable phone" is the fallback capture path,
// and iOS Voice Memos exports exactly that. It was refused at presign, so the
// one device somebody always has with them produced files this application
// would not take. ffmpeg reads the container by probing the file rather than
// its name and decodes AAC natively, so nothing downstream changes.
//
// audio/webm stays for a related reason. It stays because ffmpeg decodes it and
// dropping it would buy nothing. The
// consumer shells out to ffmpeg, which reads webm regardless of what produced
// it, so removing the type would refuse a file the pipeline can already
// process — a narrower allowlist with no corresponding narrowing of what the
// processor handles.

// 10MB, matching the published reference. Not a content constraint — a
// single-word recording is orders of magnitude below it even uncompressed —
// but a bound on what one presigned URL can cost. It is signed as
// Content-Length, so S3 rejects a larger body rather than accepting it and
// leaving the API to notice afterwards.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// How many uploads one user may have outstanding — created by presign and
// never completed. A presigned URL is a write capability handed out on
// request, so something has to bound how many exist at once.
//
// A COUNT, NOT A RATE LIMIT, and deliberately not a substitute for one. The
// throttler on Redis (still unbuilt) limits request frequency; this limits how
// much unclaimed capability is outstanding, which is the part that survives a
// client retrying slowly. Abandoned rows are the reaper's input, so they do
// not accumulate forever and this ceiling is not a trap for an honest user who
// closed a tab.
export const MAX_UNRESOLVED_UPLOADS = 10;

// -----------------------------------------------------------------------------
// PRESIGN
// -----------------------------------------------------------------------------

// No `filename`. The reference spec carried one; it is dropped because nothing
// would read it — the extension comes from contentType, the object is
// identified by the asset id, and anything a contributor wants remembered
// about the recording belongs in `notes`, which is where the rest of the
// provenance lives.
export const PresignUploadSchema = z
  .object({
    kind: MediaKindSchema,
    contentType: z.string().min(1),
    sizeBytes: z.int().positive().max(MAX_UPLOAD_BYTES),
    // PROVENANCE, AND THE ONLY PLACE IT CAN GO. `MediaAsset.notes` held
    // everything that is not the uploader — who is heard, when the recording
    // was made, the conditions, the equipment — and until now nothing could
    // write it: the column was selected, mapped and returned, and set by
    // nothing. The field a record calls "much of what makes a recording worth
    // keeping" was read-only in practice.
    //
    // Set at PRESIGN, which is where the row is created, so a note cannot
    // arrive after the fact and find no asset to attach to. There is no route
    // to edit one afterwards; that is a real limit and is left until somebody
    // needs it, rather than guessed at now.
    //
    // ONE FREE-TEXT FIELD, still. A form of separate labelled inputs composed
    // into prose was considered and rejected: it would look structured while
    // storing text, which invites the belief that it can be queried. See the
    // amendment on docs/adr/0020 for why a Speaker table is the honest version
    // of that and is deliberately deferred.
    notes: z.string().max(2000).trim().optional(),
  })
  .refine((input) => input.contentType in ACCEPTED_MEDIA_TYPES[input.kind], {
    path: ['contentType'],
    message: 'Unsupported content type for this media kind',
  });
export type PresignUpload = z.infer<typeof PresignUploadSchema>;

// What comes back is a capability and an id, and NOT a URL the file will be
// readable at. Under ADR 20 no readable URL exists until an ADMIN approves the
// asset, so returning a predicted CDN address here — as the reference spec did
// — would hand out a link that is wrong until it is approved and misleading
// until it is processed.
//
// `headers` must be sent verbatim on the PUT. They are part of what was
// signed, so S3 refuses the upload if the body disagrees with them; that is
// what makes the declared type and size a constraint rather than a claim.
export const PresignedUploadSchema = z.object({
  assetId: z.string(),
  uploadUrl: z.url(),
  headers: z.record(z.string(), z.string()),
  expiresInSeconds: z.int().positive(),
});
export type PresignedUpload = z.infer<typeof PresignedUploadSchema>;

// The asset as its owner sees it. No `sourceKey` and no `derivatives`: where
// the bytes live is internal, and a caller that needs to render media reads
// the URL on the entry or translation, which exists only once approved.
export const MediaAssetSchema = z.object({
  id: z.string(),
  kind: MediaKindSchema,
  status: MediaStatusSchema,
  contentType: z.string(),
  sizeBytes: z.int(),
  error: z.string().nullable(),
  notes: z.string().nullable(),
  isPublished: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

// -----------------------------------------------------------------------------
// ATTACHMENT
// -----------------------------------------------------------------------------

// The body of PUT /translations/:id/audio and PUT /entries/:id/image.
//
// NO expectedUpdatedAt, unlike every other write to these rows. Attaching does
// not modify the parent — it sets a foreign key and leaves `updatedAt` alone
// (docs/adr/0020) — so there is no version to contend for, and demanding one
// would make a recording fail because someone else fixed a typo. Two people
// attaching to the same row is settled by the unique constraint underneath,
// which is a race with one winner rather than a lost update.
export const AttachMediaSchema = z.object({
  assetId: z.string().min(1),
});
export type AttachMedia = z.infer<typeof AttachMediaSchema>;

// -----------------------------------------------------------------------------
// DERIVATIVES
// -----------------------------------------------------------------------------

// ⚠️ THIS IS A CONTRACT WITH A CONSUMER THAT DOES NOT EXIST YET. The media
// processor (ADR 19, still unbuilt) writes this JSON; the approval gate reads
// it to know what to copy and which file becomes the public URL. Defining it
// here rather than letting the processor invent it is deliberate — the gate
// ships first, and a shape agreed in one place beats two halves guessing.
//
// KEYS ARE RELATIVE TO THE ASSET'S PREFIX, e.g. `audio.mp3` or `960.webp`, not
// `pending/med_1/audio.mp3`. That is what makes publication a prefix swap:
// the same relative key names the object under `pending/` and under `public/`,
// so approving is a copy with one component changed and nothing to re-derive.
export const MediaDerivativeFileSchema = z.object({
  key: z.string().min(1),
  contentType: z.string().min(1),
  bytes: z.int().nonnegative(),
  // Images only — the width this rendition was resized to, so a client can
  // build a srcset without opening the files.
  width: z.int().positive().optional(),
  // Images only, and OPTIONAL FOR THE SAME REASON `width` IS — audio carries
  // neither. It is also optional in the weaker sense that assets processed
  // before this field existed have a width and no height; the read path treats
  // a rendition without one as unusable rather than guessing, since the whole
  // point of carrying it is that the aspect ratio is per-asset and cannot be
  // inferred from the width alone.
  height: z.int().positive().optional(),
});
export type MediaDerivativeFile = z.infer<typeof MediaDerivativeFileSchema>;

export const MediaDerivativesSchema = z.object({
  // Which file the public URL points at. Named rather than inferred: for audio
  // there is one obvious answer and for images there is not, and a gate that
  // guessed would put a thumbnail on a dictionary page the day someone
  // reordered the list.
  primary: z.string().min(1),
  files: z.array(MediaDerivativeFileSchema).min(1),
  // Audio only. Measured during processing, kept because a client showing a
  // player wants it before the file loads.
  durationSec: z.number().positive().optional(),
});
export type MediaDerivatives = z.infer<typeof MediaDerivativesSchema>;

// -----------------------------------------------------------------------------
// THE PROCESSING MESSAGE
// -----------------------------------------------------------------------------

// What the API puts on the media queue when an upload is confirmed, and the
// first shape in this repository that crosses a language boundary — the
// producer is TypeScript and the consumer is Python. It is defined here for
// the same reason the derivatives are: one definition, generated for the other
// side rather than transcribed. See docs/adr/0011.
//
// THE PRODUCER IS THE API, NOT AN S3 EVENT NOTIFICATION. ADR 19 originally
// specified `S3 event -> SQS -> Lambda`; its amendment explains the change.
// The short version is that S3 fires when bytes land, which happens for
// abandoned uploads too, and processing one would contradict the meaning
// AWAITING_UPLOAD exists to carry.
//
// JUST THE ID, deliberately. Every other fact about the asset — its kind, its
// source key, the type and size that were signed — is on the row, and the
// consumer must read that row anyway to check the status and increment
// `attempts`. Copying those fields into the message would create a second
// place for them to be true, and a message sitting in a queue across a
// deployment is exactly where the two would drift.
export const MediaProcessingMessageSchema = z.object({
  // Producer and consumer deploy separately — ECS and Lambda, different
  // pipelines — so a rolling release can have one running ahead of the other,
  // and messages outlive both. An explicit version lets the consumer reject
  // what it does not understand instead of silently misreading it.
  version: z.literal(1),
  assetId: z.string().min(1),
});
export type MediaProcessingMessage = z.infer<typeof MediaProcessingMessageSchema>;

export const MEDIA_PROCESSING_MESSAGE_VERSION = 1 as const;

// -----------------------------------------------------------------------------
// ADMIN REVIEW
// -----------------------------------------------------------------------------

// The review queue's row. Carries what a reviewer decides on: the asset, what
// it is attached to, and who supplied it. Provenance is included here and
// nowhere else — the public shapes have no business knowing who recorded a
// word, and the reviewer has no way to judge without it.
// What an asset is attached to, or null. Shared by the review queue and the
// uploader's own list because it answers the same question in both — WHICH WORD
// IS THIS? — and a second definition would be a second thing to keep in step.
export const MediaAttachmentSchema = z
  .object({
    kind: z.enum(['ENTRY', 'TRANSLATION']),
    id: z.string(),
    // The headword for both kinds. Judging or placing a recording is impossible
    // without knowing which word it claims to be.
    nawatContent: z.string(),
  })
  .nullable();
export type MediaAttachment = z.infer<typeof MediaAttachmentSchema>;

// The uploader's own list — GET /uploads.
//
// MediaAssetSchema PLUS the attachment, and the attachment is the whole point:
// an unattached asset is invisible in every editor by definition, so this list
// is the only place one can be found. Without it the list can say an upload
// exists and not whether it reached anything, which is the single question the
// view is for.
//
// Not folded into MediaAssetSchema itself. Presign and complete return that
// shape for an asset that by definition has no attachment yet, and an
// always-null field on both would be noise carried for one caller's benefit.
export const UploadListItemSchema = MediaAssetSchema.extend({
  attachedTo: MediaAttachmentSchema,
});
export type UploadListItem = z.infer<typeof UploadListItemSchema>;

export const AdminMediaAssetSchema = MediaAssetSchema.extend({
  uploader: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string(),
  }),
  // Null while the asset is unattached. An unattached asset cannot be
  // published — approval writes a URL onto a parent, and there is nowhere to
  // write it — so the queue shows them but the gate refuses them.
  attachedTo: MediaAttachmentSchema,
  // A short-lived presigned GET against the PENDING prefix. Review plays the
  // recording through this and never through the CDN, which cannot see
  // unapproved media at all — that is the point of the prefix split.
  previewUrl: z.url().nullable(),
});
export type AdminMediaAsset = z.infer<typeof AdminMediaAssetSchema>;

// Defaults to the set a reviewer is there to act on: processed, and not yet
// decided. The other combinations exist for looking into a specific failure.
export const MediaQuerySchema = z.object({
  status: MediaStatusSchema.optional(),
  isPublished: z.stringbool().optional(),
});
export type MediaQuery = z.infer<typeof MediaQuerySchema>;
