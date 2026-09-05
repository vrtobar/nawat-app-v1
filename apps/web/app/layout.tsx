import type { Metadata } from 'next';

// Pass-through root. The <html lang> carries the request's locale, which is only
// known inside [locale], so app/[locale]/layout.tsx renders <html>/<body> and
// imports the stylesheet. Next still requires a root layout to exist; this is
// it, and it only sets the metadata defaults that apply across every locale.
export const metadata: Metadata = {
  // Absolute base for the canonical and hreflang URLs the dictionary pages emit;
  // without it Next resolves relative alternates against localhost.
  metadataBase: new URL(process.env.APP_BASE_URL ?? 'http://localhost:3000'),
  title: {
    default: 'Nawat — an interactive dictionary and learning companion',
    template: '%s | Nawat',
  },
  description:
    'Learn Nawat, the indigenous language of El Salvador — dictionary, lessons, and spaced-repetition review.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
