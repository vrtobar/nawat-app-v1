import { prisma } from '@nahuat/database';
import { AdminMediaAssetSchema } from '@nahuat/shared';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReviewService } from './review.service';
import type { StorageService } from './storage.service';

vi.mock('@nahuat/database', () => ({
  prisma: {
    mediaAsset: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

const mediaAsset = vi.mocked(prisma.mediaAsset);
const transaction = vi.mocked(prisma.$transaction);

const tx = { mediaAsset: { update: vi.fn() }, $executeRaw: vi.fn() };

const derivatives = {
  primary: 'audio.mp3',
  files: [
    { key: 'audio.mp3', contentType: 'audio/mpeg', bytes: 2048 },
    { key: 'audio.ogg', contentType: 'audio/ogg', bytes: 1900 },
  ],
  durationSec: 1.4,
};

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'med_1',
  kind: 'AUDIO',
  status: 'READY',
  contentType: 'audio/mpeg',
  sizeBytes: 2048,
  error: null,
  notes: null,
  isPublished: false,
  createdAt: new Date('2026-08-29T12:00:00.000Z'),
  derivatives,
  uploader: { id: 'usr_1', name: 'A Contributor', email: 'c@example.com' },
  entry: null,
  translation: { id: 'tr_1', entry: { nawatContent: 'takat' } },
  ...overrides,
});

const storage = {
  copy: vi.fn(),
  delete: vi.fn(),
  head: vi.fn(),
  presignGet: vi.fn(),
};

const config = { getOrThrow: vi.fn(() => 'https://cdn.staging.nahuat.com') };

const service = new ReviewService(
  storage as unknown as StorageService,
  config as unknown as ConfigService,
);

beforeEach(() => {
  vi.clearAllMocks();
  storage.head.mockResolvedValue({ sizeBytes: 2048, contentType: 'audio/mpeg' });
  storage.presignGet.mockResolvedValue('https://bucket.s3/pending/med_1/audio.mp3?sig');
  // $transaction is overloaded (callback form and array form), so the mock is
  // cast rather than typed against it — the callback shape is what this service
  // uses and what these tests exercise.
  transaction.mockImplementation((async (fn: (t: typeof tx) => Promise<unknown>) =>
    fn(tx)) as never);
});

describe('publish', () => {
  it('copies every derivative from pending into public', async () => {
    mediaAsset.findUnique.mockResolvedValue(row() as never);

    await service.publish('usr_admin', 'med_1');

    expect(storage.copy).toHaveBeenCalledTimes(2);
    expect(storage.copy).toHaveBeenCalledWith('pending/med_1/audio.mp3', 'public/med_1/audio.mp3');
    expect(storage.copy).toHaveBeenCalledWith('pending/med_1/audio.ogg', 'public/med_1/audio.ogg');
  });

  it('writes a URL WITHOUT the public prefix, because the origin path adds it', async () => {
    // The distribution sets origin_path = "/public", so a URL containing the
    // prefix resolves to public/public/... and 404s. This is the one assertion
    // that couples the API to the Terraform, and it is why it is spelled out.
    mediaAsset.findUnique.mockResolvedValue(row() as never);

    await service.publish('usr_admin', 'med_1');

    const sql = (tx.$executeRaw.mock.calls[0]?.[0] as string[]).join('?');
    const params = tx.$executeRaw.mock.calls[0]?.slice(1);
    expect(sql).toContain('audio_url');
    expect(params).toContain('https://cdn.staging.nahuat.com/med_1/audio.mp3');
    expect(params?.join()).not.toContain('/public/');
  });

  it('verifies the copied file is readable before writing anything', async () => {
    mediaAsset.findUnique.mockResolvedValue(row() as never);
    storage.head.mockResolvedValue(undefined);

    await expect(service.publish('usr_admin', 'med_1')).rejects.toBeInstanceOf(ConflictException);
    // Nothing written: a copy that returned without error is not evidence the
    // object is there.
    expect(transaction).not.toHaveBeenCalled();
  });

  it('leaves the asset unpublished when a copy fails', async () => {
    mediaAsset.findUnique.mockResolvedValue(row() as never);
    storage.copy.mockRejectedValueOnce(new Error('AccessDenied'));

    await expect(service.publish('usr_admin', 'med_1')).rejects.toThrow('AccessDenied');
    // Copy first, database last — so a failure is a retryable no-op rather
    // than a row advertising media that is not there.
    expect(transaction).not.toHaveBeenCalled();
  });

  it('writes image_url when the asset hangs on an entry', async () => {
    mediaAsset.findUnique.mockResolvedValue(
      row({
        kind: 'IMAGE',
        translation: null,
        entry: { id: 'ent_1', nawatContent: 'takat' },
        derivatives: {
          primary: '960.webp',
          files: [{ key: '960.webp', contentType: 'image/webp', bytes: 40_000, width: 960 }],
        },
      }) as never,
    );

    await service.publish('usr_admin', 'med_1');

    expect((tx.$executeRaw.mock.calls[0]?.[0] as string[]).join('?')).toContain('image_url');
  });

  it('writes the rendition ladder beside image_url, narrowest first', async () => {
    mediaAsset.findUnique.mockResolvedValue(
      row({
        kind: 'IMAGE',
        translation: null,
        entry: { id: 'ent_1', nawatContent: 'takat' },
        derivatives: {
          primary: '640.webp',
          files: [
            { key: '960.webp', contentType: 'image/webp', bytes: 95_020, width: 960, height: 1280 },
            { key: '320.webp', contentType: 'image/webp', bytes: 21_840, width: 320, height: 427 },
            { key: '640.webp', contentType: 'image/webp', bytes: 54_818, width: 640, height: 853 },
          ],
        },
      }) as never,
    );

    await service.publish('usr_admin', 'med_1');

    const sql = (tx.$executeRaw.mock.calls[0]?.[0] as string[]).join('?');
    const params = tx.$executeRaw.mock.calls[0]?.slice(1);
    expect(sql).toContain('image_renditions');

    // JSON TEXT, not an object: handed to the driver as an array of objects it
    // would be encoded as a Postgres array literal rather than JSON.
    expect(typeof params?.[1]).toBe('string');
    expect(JSON.parse(params?.[1] as string)).toEqual([
      { width: 320, height: 427, url: 'https://cdn.staging.nahuat.com/med_1/320.webp' },
      { width: 640, height: 853, url: 'https://cdn.staging.nahuat.com/med_1/640.webp' },
      { width: 960, height: 1280, url: 'https://cdn.staging.nahuat.com/med_1/960.webp' },
    ]);
  });

  it('writes a NULL ladder when the processor recorded no heights', async () => {
    // An asset processed before `height` existed. It still publishes and still
    // gets a URL — the reader falls back to the primary alone, which is exactly
    // what every reader did before renditions were carried at all.
    mediaAsset.findUnique.mockResolvedValue(
      row({
        kind: 'IMAGE',
        translation: null,
        entry: { id: 'ent_1', nawatContent: 'takat' },
        derivatives: {
          primary: '640.webp',
          files: [
            { key: '320.webp', contentType: 'image/webp', bytes: 21_840, width: 320 },
            { key: '640.webp', contentType: 'image/webp', bytes: 54_818, width: 640 },
          ],
        },
      }) as never,
    );

    await service.publish('usr_admin', 'med_1');

    expect(tx.$executeRaw.mock.calls[0]?.slice(1)[1]).toBeNull();
  });

  it('writes a NULL ladder when only some renditions are measured', async () => {
    // NULL RATHER THAN THE MEASURABLE SUBSET. A short srcset is indistinguishable
    // from a complete one to the client, so handing it a ladder missing the
    // widths it most wanted would be worse than handing it none.
    mediaAsset.findUnique.mockResolvedValue(
      row({
        kind: 'IMAGE',
        translation: null,
        entry: { id: 'ent_1', nawatContent: 'takat' },
        derivatives: {
          primary: '640.webp',
          files: [
            { key: '320.webp', contentType: 'image/webp', bytes: 21_840, width: 320, height: 427 },
            { key: '640.webp', contentType: 'image/webp', bytes: 54_818, width: 640 },
          ],
        },
      }) as never,
    );

    await service.publish('usr_admin', 'med_1');

    expect(tx.$executeRaw.mock.calls[0]?.slice(1)[1]).toBeNull();
  });

  it('refuses an asset that is not READY', async () => {
    mediaAsset.findUnique.mockResolvedValue(row({ status: 'PENDING' }) as never);

    await expect(service.publish('usr_admin', 'med_1')).rejects.toBeInstanceOf(ConflictException);
    expect(storage.copy).not.toHaveBeenCalled();
  });

  it('refuses an asset attached to nothing', async () => {
    mediaAsset.findUnique.mockResolvedValue(row({ translation: null, entry: null }) as never);

    await expect(service.publish('usr_admin', 'med_1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses derivatives that are missing, or that name a primary not in the list', async () => {
    mediaAsset.findUnique.mockResolvedValue(row({ derivatives: null }) as never);
    await expect(service.publish('usr_admin', 'med_1')).rejects.toBeInstanceOf(ConflictException);

    mediaAsset.findUnique.mockResolvedValue(
      row({ derivatives: { ...derivatives, primary: 'nope.mp3' } }) as never,
    );
    await expect(service.publish('usr_admin', 'med_1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('is idempotent once published', async () => {
    mediaAsset.findUnique.mockResolvedValue(row({ isPublished: true }) as never);

    await service.publish('usr_admin', 'med_1');

    expect(storage.copy).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('404s an unknown asset', async () => {
    mediaAsset.findUnique.mockResolvedValue(null as never);
    await expect(service.publish('usr_admin', 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('unpublish', () => {
  it('clears the URL and deletes the public copies, keeping the pending ones', async () => {
    mediaAsset.findUnique.mockResolvedValue(row({ isPublished: true }) as never);

    await service.unpublish('med_1');

    expect((tx.$executeRaw.mock.calls[0]?.[0] as string[]).join('?')).toContain('audio_url = NULL');
    expect(storage.delete).toHaveBeenCalledWith('public/med_1/audio.mp3');
    expect(storage.delete).toHaveBeenCalledWith('public/med_1/audio.ogg');
    // Pending survives, so re-approval needs no reprocessing.
    for (const call of storage.delete.mock.calls) {
      expect(call[0]).not.toContain('pending/');
    }
  });

  it('clears the rendition ladder with the URL', async () => {
    mediaAsset.findUnique.mockResolvedValue(
      row({
        isPublished: true,
        kind: 'IMAGE',
        translation: null,
        entry: { id: 'ent_1', nawatContent: 'takat' },
        derivatives: {
          primary: '640.webp',
          files: [
            { key: '640.webp', contentType: 'image/webp', bytes: 54_818, width: 640, height: 853 },
          ],
        },
      }) as never,
    );

    await service.unpublish('med_1');

    // Both in one statement: an entry keeping a ladder whose URL is gone would
    // advertise media the gate has just made unreachable.
    const sql = (tx.$executeRaw.mock.calls[0]?.[0] as string[]).join('?');
    expect(sql).toContain('image_url = NULL');
    expect(sql).toContain('image_renditions = NULL');
  });

  it('is idempotent when the asset was never published', async () => {
    mediaAsset.findUnique.mockResolvedValue(row() as never);

    await service.unpublish('med_1');

    expect(transaction).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

describe('list', () => {
  it('defaults to the set awaiting a decision, oldest first', async () => {
    mediaAsset.findMany.mockResolvedValue([row()] as never);

    const result = await service.list({});

    expect(mediaAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'READY', isPublished: false },
        orderBy: { createdAt: 'asc' },
      }),
    );
    // Matches media_assets_review_queue_idx, which is partial on exactly this
    // predicate — if the filter drifts, the index silently stops being used.
    expect(() => AdminMediaAssetSchema.strict().parse(result[0])).not.toThrow();
  });

  it('signs the preview against pending, never the CDN', async () => {
    mediaAsset.findMany.mockResolvedValue([row()] as never);

    await service.list({});

    // CloudFront cannot read the pending prefix at all, so review has to go
    // through a signed request or not happen.
    expect(storage.presignGet).toHaveBeenCalledWith('pending/med_1/audio.mp3');
  });

  it('has no preview for an asset whose derivatives are unusable', async () => {
    mediaAsset.findMany.mockResolvedValue([row({ status: 'FAILED', derivatives: null })] as never);

    const result = await service.list({ status: 'FAILED' });

    expect(result[0]?.previewUrl).toBeNull();
    expect(storage.presignGet).not.toHaveBeenCalled();
  });
});
