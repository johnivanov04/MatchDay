import type { MetadataRoute } from 'next';

/**
 * PWA manifest.
 *
 * Installability is not cosmetic here: on iOS, Web Push only works once a site
 * has been added to the home screen, so the manifest is a prerequisite for the
 * phone notifications this phase exists to deliver.
 *
 * PHASE 7 ADDED THE PNGs. Phase 5 shipped an SVG only and recorded real
 * rasters as a follow-up. Chrome accepts `sizes: "any"` SVG for installability,
 * so this was never a functional blocker — it was a shabby install.
 *
 * Precisely what it fixes: iOS does not render SVG for a home-screen icon, and
 * falls back to a screenshot thumbnail of the page. Somebody adding Matchday to
 * their home screen — which on iOS is separately a prerequisite for Web Push —
 * got a blurry crop of whatever page they happened to be on instead of an app
 * icon. Push itself would still have worked; it simply would not have looked
 * like a product anybody trusted with their Sunday fixture.
 *
 * They are rendered from `public/icon.svg` rather than drawn: same artwork,
 * three formats. See `docs/operations/production.md` for the command, so a
 * future change to the SVG can regenerate them rather than leave them stale.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Matchday',
    short_name: 'Matchday',
    description:
      'Organise pickup matches: membership, guidelines, matches and notifications for every league you play in.',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#1f7a4d',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // `maskable` lets Android crop to whatever shape the launcher uses. The
      // artwork is a rounded square on a solid field, so the safe zone is
      // already respected and the same file serves both purposes.
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      // Kept last and unsized so a browser that prefers vectors can take it,
      // without any browser treating it as the only option.
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}
