import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApiError } from '../../../../lib/api/client';
import { getEntryBySlug } from '../../../../lib/api/dictionary';
import { isLocale, type Locale } from '../../../../lib/locale';

const STRINGS = {
  es: { back: '← Volver al diccionario', expression: 'expresión', illustration: 'Ilustración de' },
  en: {
    back: '← Back to the dictionary',
    expression: 'expression',
    illustration: 'Illustration of',
  },
} as const satisfies Record<Locale, Record<string, string>>;

const POS_LABELS = {
  es: {
    NOUN: 'sustantivo',
    VERB: 'verbo',
    ADJECTIVE: 'adjetivo',
    ADVERB: 'adverbio',
    PRONOUN: 'pronombre',
    PARTICLE: 'partícula',
    PREPOSITION: 'preposición',
    CONJUNCTION: 'conjunción',
    OTHER: 'otro',
  },
  en: {
    NOUN: 'noun',
    VERB: 'verb',
    ADJECTIVE: 'adjective',
    ADVERB: 'adverb',
    PRONOUN: 'pronoun',
    PARTICLE: 'particle',
    PREPOSITION: 'preposition',
    CONJUNCTION: 'conjunction',
    OTHER: 'other',
  },
} as const;

type Params = { locale: string; slug: string };

// generateMetadata and the page both call getEntryBySlug; Next memoizes identical
// fetches within a request, so this is one HTTP call, not two.
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};

  try {
    const entry = await getEntryBySlug(slug, locale);
    return {
      title: entry.nawatContent,
      description: entry.translations[0]?.content,
      alternates: {
        canonical: `/${locale}/dictionary/${entry.slug}`,
        // Both locales resolve the same entry by slug — declare them as hreflang
        // alternates so a search engine serves the right language per user.
        languages: {
          es: `/es/dictionary/${entry.slug}`,
          en: `/en/dictionary/${entry.slug}`,
        },
      },
    };
  } catch {
    // A missing entry gets the default title; the page itself renders notFound().
    return {};
  }
}

export default async function EntryDetailPage({ params }: { params: Promise<Params> }) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();

  let entry;
  try {
    entry = await getEntryBySlug(slug, locale);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.code === 'ENTRY_NOT_FOUND')) {
      notFound();
    }
    throw error;
  }

  const t = STRINGS[locale];
  const pos = POS_LABELS[locale];

  // The rendition `imageUrl` actually points at, found BY URL rather than by
  // assuming the standard width: the processor falls back to the widest it
  // produced when the source is narrower than 640, so the primary of a small
  // image is not 640 and hardcoding that would reserve a box of the wrong shape.
  //
  // Its dimensions are what `width`/`height` state, and with `h-auto w-full`
  // they act as an aspect ratio rather than a size — the box is reserved at the
  // right shape before any byte arrives, whichever rendition the srcset picks.
  const primaryRendition = entry.imageRenditions?.find((r) => r.url === entry.imageUrl) ?? null;

  // schema.org DefinedTerm: marks the page as a dictionary entry for the Nawat
  // word (ISO 639-3 'ppl'), which is the SEO lever that matters more than the URL.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'DefinedTerm',
    name: entry.nawatContent,
    inLanguage: 'ppl',
    description: entry.translations[0]?.content,
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <Link href={`/${locale}/dictionary`} className="text-sm text-gray-500 hover:underline">
        {t.back}
      </Link>

      <header className="mt-4 flex items-baseline gap-3">
        <h1 className="text-4xl font-bold">{entry.nawatContent}</h1>
        {entry.type === 'EXPRESSION' && (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-sm text-amber-800">
            {t.expression}
          </span>
        )}
      </header>

      {/* THE ENTRY'S IMAGE, not a translation's — which is why it sits here
          rather than inside the list below. `imageUrl` hangs off the entry and
          `audioUrl` off each translation, and the layout follows that ownership.

          `imageRenditions` carries the ladder the processor produced, with each
          rendition's own height. The client cannot derive it: the processor
          never upscales, so an 800px source yields 320/640/800 and a phone photo
          320/640/960, and a hardcoded srcset would request an object that does
          not exist for one of them.

          NULL IS A REAL CASE, not a defensive check — an entry approved before
          the processor recorded heights has a URL and no ladder. It then renders
          exactly as it did before this existed: the primary alone, no srcset,
          and a reflow as it loads.

          `sizes` says what the CSS already says: capped at max-w-md (28rem =
          448px) and full-width below that. Getting it wrong is not cosmetic —
          the browser picks from it before layout, so a lie here downloads the
          wrong rendition and the srcset stops paying for itself.

          Still a plain <img>. next/image is now possible — the dimensions exist
          — but it would route these through the optimizer, re-encoding files the
          pipeline has already sized and stripped. That is a separate decision,
          not a consequence of this one. */}
      {entry.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={entry.imageUrl}
          {...(primaryRendition && {
            srcSet: entry.imageRenditions!.map((r) => `${r.url} ${r.width}w`).join(', '),
            sizes: '(max-width: 448px) 100vw, 448px',
            width: primaryRendition.width,
            height: primaryRendition.height,
          })}
          alt={`${t.illustration} ${entry.nawatContent}`}
          className="mt-6 h-auto w-full max-w-md rounded-md border border-gray-100"
        />
      )}

      <section className="mt-8 space-y-8">
        {entry.translations.map((tr) => (
          <article key={tr.id} className="border-t border-gray-100 pt-6">
            <div className="flex items-baseline gap-2">
              <span className="text-xs uppercase tracking-wide text-gray-400">
                {locale === 'es' ? tr.dialect.nameEs : tr.dialect.nameEn}
              </span>
              {tr.partOfSpeech && (
                <span className="text-xs italic text-gray-500">{pos[tr.partOfSpeech]}</span>
              )}
              {tr.phonetic && <span className="text-sm text-gray-500">/{tr.phonetic}/</span>}
            </div>

            <p className="mt-1 text-xl">{tr.content}</p>

            {tr.audioUrl && <audio controls src={tr.audioUrl} className="mt-3 h-8" />}

            {tr.exampleNawat && (
              <div className="mt-3 rounded-md bg-gray-50 p-3">
                <p className="font-medium">{tr.exampleNawat}</p>
                {tr.example && <p className="text-gray-600">{tr.example}</p>}
              </div>
            )}
          </article>
        ))}
      </section>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </main>
  );
}
