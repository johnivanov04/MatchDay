import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The rules that keep avatar rendering from drifting, asserted against the
 * source tree itself.
 *
 * ── WHY A SOURCE-SHAPE TEST AND NOT A BEHAVIOURAL ONE ──────────────────────
 *
 * Nine surfaces render other players. The privacy properties here are not
 * things a component *does* — they are things no component may be *able* to do:
 *
 *   * only one file turns a path into a URL, so a change of bucket or origin is
 *     one edit and not nine, and there is exactly one place where an
 *     unvalidated value could be concatenated into an `<img src>`;
 *   * only the self-profile flow ever reads `profile_photo_url`, because a
 *     legacy address points at a host nobody here controls and rendering one
 *     for somebody else discloses their IP and user agent to whoever runs it;
 *   * only one component emits an `<img>` at all, so the broken-image fallback
 *     cannot be forgotten by the tenth surface somebody adds.
 *
 * A behavioural test proves the nine surfaces we wrote today are correct. This
 * proves the tenth cannot be written wrong without a test failing, which is the
 * property that actually survives the next phase.
 *
 * Matched against a stripped copy of each file, so a rule discussed in a
 * comment — and these files discuss them at length — is never mistaken for a
 * violation.
 */

const SRC = join(process.cwd(), 'src');

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

/** Comments removed, so prose about a rule is not read as a breach of it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

/** Repository-relative, so a failure names a file somebody can open. */
const relative = (path: string) => path.slice(process.cwd().length + 1);

const FILES = sourceFiles(SRC);

function filesWhere(predicate: (body: string) => boolean): string[] {
  return FILES.filter((path) => predicate(code(path))).map(relative).sort();
}

describe('URL construction lives in exactly one place', () => {
  it('is called only by the shared PlayerAvatar wrapper', () => {
    expect(filesWhere((body) => /\bmanagedAvatarUrl\s*\(/.test(body))).toEqual([
      'src/components/ui/player-avatar.tsx',
      'src/lib/profile/avatar.ts',
    ]);
  });

  it('never has the public object route spelled out anywhere else', () => {
    // `/storage/v1/object/public/` appearing in a component would mean somebody
    // rebuilt the URL by hand and skipped the shape validation with it.
    expect(filesWhere((body) => body.includes('/storage/v1/object/public'))).toEqual([
      'src/lib/profile/avatar.ts',
    ]);
  });

  it('keeps the low-level builder out of components', () => {
    expect(filesWhere((body) => /\bavatarPublicUrl\s*\(/.test(body))).toEqual([
      'src/lib/profile/avatar.ts',
    ]);
  });
});

describe('the legacy photo column reaches only the self-profile flow', () => {
  it('is read as a property in one place only', () => {
    // `avatarImageUrl` is the self resolver and the only thing that falls back
    // to a legacy address.
    expect(filesWhere((body) => /\.profile_photo_url\b/.test(body))).toEqual([
      'src/lib/profile/avatar.ts',
    ]);
  });

  it('is written only by the avatar action, and only to clear it', () => {
    const writers = filesWhere((body) => /profile_photo_url\s*:/.test(body));

    // The two type declarations plus the action that nulls the column on
    // upload and on removal. No form, no projection, no component.
    expect(writers).toEqual([
      'src/lib/profile/avatar.ts',
      'src/server/actions/avatar.ts',
      'src/types/database.ts',
    ]);
  });

  it('appears in no component under src/components', () => {
    const components = FILES.filter((path) => relative(path).startsWith('src/components/'));
    const offenders = components
      .filter((path) => /profile_photo_url/.test(code(path)))
      .map(relative);

    // `PlayerAvatar`'s prop type physically cannot express one; this is the
    // assertion that nothing routes around it.
    expect(offenders).toEqual([]);
  });

  it('is resolved for the signed-in user only where that is the subject', () => {
    expect(filesWhere((body) => /\bavatarImageUrl\s*\(/.test(body))).toEqual([
      'src/app/(app)/layout.tsx',
      'src/app/(app)/profile/page.tsx',
      'src/lib/profile/avatar.ts',
    ]);
  });
});

describe('one component owns the broken-image fallback', () => {
  it('is the only file that renders an img element', () => {
    // Any other surface emitting its own `<img>` would be one that shows the
    // browser's broken-image glyph when an object is missing — which reads as a
    // fault in Matchday rather than as a member without a photo.
    expect(filesWhere((body) => /<img[\s/>]/.test(body))).toEqual([
      'src/components/ui/avatar.tsx',
    ]);
  });
});

describe('no projection type carries the legacy column', () => {
  it('keeps it off every projected player row', () => {
    const types = readFileSync(join(SRC, 'types', 'database.ts'), 'utf8');

    for (const name of [
      'ConfirmedRosterEntry',
      'RosterAdminEntry',
      'TeamBuilderPlayer',
      'PublishedTeamEntry',
      'AttendanceWorkspaceEntry',
    ]) {
      const declaration = types.slice(types.indexOf(`export type ${name} = {`));
      const body = declaration.slice(0, declaration.indexOf('};'));

      expect(body, `${name} exposes the avatar path`).toContain('profile_photo_path');
      expect(body, `${name} must not expose the legacy url`).not.toContain('profile_photo_url');
      expect(body, `${name} must not expose a phone number`).not.toContain('phone');
    }
  });
});
