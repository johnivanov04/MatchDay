'use client';

/**
 * The last boundary: a failure in the root layout itself.
 *
 * It replaces the whole document, which is why this file renders `<html>` and
 * `<body>` when no other component does — by the time it runs, the layout that
 * would have provided them is what failed.
 *
 * Styles are inline for the same reason. `globals.css` is imported by the root
 * layout, so a failure there can mean the stylesheet never loaded, and a
 * class-based fallback would render as unstyled text on white. This is the one
 * file in the codebase where that trade is worth making.
 *
 * No message, no digest, no retry into the same broken layout: the only offer
 * that reliably works from here is a fresh navigation to the dashboard.
 */
export default function GlobalError() {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1.5rem',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          backgroundColor: '#ffffff',
          color: '#14181c',
        }}
      >
        <main role="alert" style={{ maxWidth: '32rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.5rem' }}>
            Matchday could not load
          </h1>
          <p style={{ fontSize: '0.9375rem', lineHeight: 1.5, margin: '0 0 1.25rem' }}>
            Something went wrong before the page could start. Reloading usually fixes it.
          </p>
          <a
            href="/dashboard"
            style={{
              display: 'inline-flex',
              minHeight: '44px',
              alignItems: 'center',
              borderRadius: '0.5rem',
              backgroundColor: '#166534',
              color: '#ffffff',
              padding: '0 1.25rem',
              fontSize: '0.875rem',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Reload Matchday
          </a>
        </main>
      </body>
    </html>
  );
}
