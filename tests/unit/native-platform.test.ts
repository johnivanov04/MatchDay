import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_IOS_USER_AGENT_TAG,
  isNativeIOSUserAgent,
} from '@/lib/platform/native';

/**
 * The one signal that tells MatchDay it is running inside the iOS app.
 *
 * ── WHY THIS IS WORTH TESTING AT ALL ───────────────────────────────────────
 *
 * The tag is a string in `capacitor.config.ts` and the same string in
 * `src/lib/platform/native.ts`. Nothing in the type system connects them, and
 * nothing fails loudly if they drift: the app simply stops recognising itself,
 * silently reverts to the web copy, and starts telling App Store users to add
 * MatchDay to their home screen from Safari. That is a Guideline 4.2 rejection
 * caused by a typo, so the two files are pinned together here.
 */

const CAPACITOR_CONFIG = readFileSync('capacitor.config.ts', 'utf8');

describe('the native user-agent tag', () => {
  it('matches the tag Capacitor appends', () => {
    expect(CAPACITOR_CONFIG).toContain(`appendUserAgent: '${NATIVE_IOS_USER_AGENT_TAG}'`);
  });

  it('is not a word a real browser sends', () => {
    // A tag like "Safari" or "Mobile" would match every iPhone on the web.
    const realWorldAgents = [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    ];

    for (const agent of realWorldAgents) {
      expect(isNativeIOSUserAgent(agent), `${agent.slice(0, 40)}… was read as native`).toBe(false);
    }
  });
});

describe('isNativeIOSUserAgent', () => {
  it('recognises the app', () => {
    // What WKWebView actually sends: Safari's agent with our suffix appended.
    expect(
      isNativeIOSUserAgent(
        `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ${NATIVE_IOS_USER_AGENT_TAG}`,
      ),
    ).toBe(true);
  });

  it('treats a missing user agent as not native', () => {
    // A request with no User-Agent is a crawler or a probe, not the app.
    expect(isNativeIOSUserAgent(null)).toBe(false);
    expect(isNativeIOSUserAgent(undefined)).toBe(false);
    expect(isNativeIOSUserAgent('')).toBe(false);
  });
});

describe('the Capacitor configuration', () => {
  it('points at the canonical production origin', () => {
    expect(CAPACITOR_CONFIG).toContain("url: 'https://app.matchdayapps.com'");
  });

  it('uses the agreed bundle identifier and display name', () => {
    expect(CAPACITOR_CONFIG).toContain("appId: 'com.johnivanov.matchday'");
    expect(CAPACITOR_CONFIG).toContain("appName: 'MatchDay'");
  });

  it('refuses cleartext, so no redirect can downgrade the app to HTTP', () => {
    expect(CAPACITOR_CONFIG).toContain('cleartext: false');
  });

  it('keeps the navigation allowlist narrow', () => {
    // The webview may navigate to MatchDay and to Supabase, and nowhere else.
    // Anything wider would let an administrator-supplied link replace the
    // signed-in session with an arbitrary page.
    const match = /allowNavigation: \[([^\]]*)\]/s.exec(CAPACITOR_CONFIG);
    expect(match, 'allowNavigation is not declared').not.toBeNull();

    const origins = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
    expect(origins).toEqual([
      'app.matchdayapps.com',
      'match-day-lake.vercel.app',
      '*.supabase.co',
    ]);
  });

  it('holds the splash until the app says it has painted', () => {
    // An automatic timeout would uncover a blank webview on a slow connection,
    // which is the exact moment the splash exists for.
    expect(CAPACITOR_CONFIG).toContain('launchAutoHide: false');
  });

  it('points its error path at the bundled offline screen', () => {
    expect(CAPACITOR_CONFIG).toContain("errorPath: 'offline.html'");
    // And that screen has to exist, or a network failure is a blank webview.
    expect(() => readFileSync('native/web/offline.html', 'utf8')).not.toThrow();
  });
});

describe('the bundled offline screen', () => {
  const html = readFileSync('native/web/offline.html', 'utf8');
  const css = readFileSync('native/web/offline.css', 'utf8');

  it('fetches nothing, because the network is what failed', () => {
    // No CDN font, no remote image, no analytics beacon: every one of those
    // would be a spinner on a screen whose entire premise is that the network
    // is unreachable.
    expect(html).not.toMatch(/https?:\/\//);
    expect(css).not.toMatch(/https?:\/\//);
  });

  it('offers a way out', () => {
    expect(html).toContain('id="retry"');
    expect(html).toContain('location.reload');
  });

  it('respects the safe area, since it can be the first screen shown', () => {
    expect(css).toContain('env(safe-area-inset-top)');
    expect(css).toContain('env(safe-area-inset-bottom)');
  });

  it('follows the system appearance', () => {
    expect(css).toContain('prefers-color-scheme: dark');
  });
});

describe('safe-area handling', () => {
  const globals = readFileSync('src/app/globals.css', 'utf8');
  const shell = readFileSync('src/components/app-shell.tsx', 'utf8');

  it('declares both insets exactly once', () => {
    expect(globals.match(/@utility pt-safe/g)).toHaveLength(1);
    expect(globals.match(/@utility pb-safe/g)).toHaveLength(1);
  });

  it('applies the top inset to the app bar, and only there', () => {
    // Padding a scroll container *and* its sticky header is how an app ends up
    // with a gap that grows every time somebody adds a wrapper.
    expect(shell).toContain('pt-safe sticky top-0');

    const appliedInShell = (shell.match(/pt-safe/g) ?? []).length;
    // Once in the class list, once in the comment above it.
    expect(appliedInShell).toBeLessThanOrEqual(2);
  });

  it('does not add the bottom inset a second time', () => {
    // `pb-safe` is already on the tab bar and the three sheets. The footer
    // carries the tab-bar clearance and must not also carry the inset.
    expect(shell).not.toContain('pb-safe');
  });

  it('opts the viewport into the full screen, or the insets are all zero', () => {
    const layout = readFileSync('src/app/layout.tsx', 'utf8');
    expect(layout).toContain("viewportFit: 'cover'");
  });
});
