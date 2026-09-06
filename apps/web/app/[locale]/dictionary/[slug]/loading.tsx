// The entry page's skeleton. See the note in ../loading.tsx for why this exists
// at all; this one mirrors the detail layout rather than the list.
//
// NO IMAGE PLACEHOLDER, deliberately. Most entries carry no image, so reserving
// a box for one would make the skeleton lie about the shape of the page for the
// common case — and the entries that do have an image already reserve their own
// space from the rendition dimensions, which is a better answer than a guess.
export default function Loading() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-8" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className="h-5 w-24 animate-pulse rounded bg-gray-100" />
      <div className="mt-4 h-10 w-56 animate-pulse rounded bg-gray-200" />
      <div className="mt-8 space-y-8">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="border-t border-gray-100 pt-6">
            <div className="h-4 w-28 animate-pulse rounded bg-gray-100" />
            <div className="mt-2 h-6 w-64 animate-pulse rounded bg-gray-200" />
          </div>
        ))}
      </div>
    </main>
  );
}
