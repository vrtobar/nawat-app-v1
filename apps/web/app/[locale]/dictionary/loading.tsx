// Rendered the instant a navigation into the dictionary list starts.
//
// WITHOUT THIS THERE IS NO INTERMEDIATE STATE. Both dictionary pages are Server
// Components, so a click means fetching the RSC payload, which calls the API,
// which queries Postgres — and until all of that returns the previous page
// simply sits there, then swaps wholesale. A frozen UI followed by an instant
// full replacement is indistinguishable from a document reload, which is what
// this looked like despite next/link never re-requesting the document.
//
// It also makes <Link> prefetching worth something. Prefetch is on by default,
// but for a dynamic route it can only prefetch the loading state; with no
// loading state there was nothing to fetch ahead.
//
// The shape mirrors page.tsx — same max-width, same spacing, a heading block and
// rows at the list's rhythm — so the skeleton occupies the space the content
// will, and the swap is a fill rather than a jump.
export default function Loading() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-8" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className="mb-6 h-9 w-48 animate-pulse rounded bg-gray-200" />
      <div className="h-10 w-full animate-pulse rounded bg-gray-100" />
      <div className="mt-4 flex gap-2">
        <div className="h-7 w-20 animate-pulse rounded bg-gray-100" />
        <div className="h-7 w-24 animate-pulse rounded bg-gray-100" />
      </div>
      <ul className="mt-6 divide-y divide-gray-100">
        {Array.from({ length: 8 }, (_, i) => (
          <li key={i} className="flex items-baseline justify-between gap-4 py-3">
            <div className="h-5 w-32 animate-pulse rounded bg-gray-200" />
            <div className="h-5 w-40 animate-pulse rounded bg-gray-100" />
          </li>
        ))}
      </ul>
    </main>
  );
}
