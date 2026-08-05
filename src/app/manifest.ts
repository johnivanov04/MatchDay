import type { MetadataRoute } from 'next';

/**
 * PWA manifest.
 *
 * Installability is not cosmetic here: on iOS, Web Push only works once a site
 * has been added to the home screen, so the manifest is a prerequisite for the
 * phone notifications this phase exists to deliver.
 *
 * The icon is an SVG because the repository has no PNG assets and generating
 * plausible ones would be inventing artwork rather than shipping a feature.
 * Chrome accepts `sizes: "any"` SVG for installability; real 192px and 512px
 * PNGs are recorded as a manual follow-up in NEXT_STEPS.md.
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
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  };
}
