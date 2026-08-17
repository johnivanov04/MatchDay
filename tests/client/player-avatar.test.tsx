import { describe, expect, it } from 'vitest';
import { PlayerAvatar } from '@/components/ui/player-avatar';
import { fire, render } from './helpers/render';

/**
 * `PlayerAvatar` — the one component every other-player surface renders.
 *
 * Two things are worth testing here rather than in `avatar.test.tsx`: that a
 * managed path resolves through the shared helper (so nine surfaces do not each
 * build a URL), and that anything malformed degrades to initials rather than
 * producing an `<img>` pointed at whatever the string happened to be.
 */

const SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
const OWNER = '11111111-1111-4111-8111-000000000003';
const FILE = 'a0000000-0000-4000-8000-000000000001';
const PATH = `${OWNER}/${FILE}.jpg`;

function player(profile_photo_path: string | null) {
  return { first_name: 'Sam', last_name: 'Okafor', profile_photo_path };
}

describe('a managed path', () => {
  it('renders the public Storage image', async () => {
    const { container, unmount } = await render(<PlayerAvatar player={player(PATH)} />);

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe(
      `${SUPABASE_URL}/storage/v1/object/public/avatars/${PATH}`,
    );
    unmount();
  });

  it('carries the member name as alt text', async () => {
    const { container, unmount } = await render(<PlayerAvatar player={player(PATH)} />);

    expect(container.querySelector('img')?.getAttribute('alt')).toBe(
      'Sam Okafor, profile photo',
    );
    unmount();
  });

  it('is lazy, because a roster is twenty of these below the fold', async () => {
    const { container, unmount } = await render(<PlayerAvatar player={player(PATH)} />);

    expect(container.querySelector('img')?.getAttribute('loading')).toBe('lazy');
    unmount();
  });

  it('honours the requested size', async () => {
    const { container, unmount } = await render(
      <PlayerAvatar player={player(PATH)} size={24} />,
    );

    const circle = container.firstElementChild as HTMLElement;
    expect(circle.style.width).toBe('24px');
    expect(circle.style.height).toBe('24px');
    unmount();
  });

  it('stays circular and cropped rather than squashed', async () => {
    const { container, unmount } = await render(<PlayerAvatar player={player(PATH)} />);

    expect((container.firstElementChild as HTMLElement).className).toContain('rounded-full');
    expect((container.firstElementChild as HTMLElement).className).toContain('shrink-0');
    expect(container.querySelector('img')?.className).toContain('object-cover');
    unmount();
  });
});

describe('no path', () => {
  it('renders initials', async () => {
    const { container, unmount } = await render(<PlayerAvatar player={player(null)} />);

    expect(container.textContent).toContain('SO');
    expect(container.querySelector('img')).toBeNull();
    unmount();
  });

  it('names itself for a screen reader', async () => {
    const { container, unmount } = await render(<PlayerAvatar player={player(null)} />);

    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      'Sam Okafor, no profile photo',
    );
    unmount();
  });
});

describe('a malformed path', () => {
  it('renders initials rather than an image, for every rejected shape', async () => {
    for (const path of [
      '',
      'not-a-uuid/x.jpg',
      `${OWNER}/nested/${FILE}.jpg`,
      `../${OWNER}/${FILE}.jpg`,
      `${OWNER}/${FILE}.png`,
      'https://cdn.elsewhere.test/sam.jpg',
      `//cdn.elsewhere.test/${FILE}.jpg`,
      `${OWNER}/${FILE}.jpg?x=1`,
    ]) {
      const { container, unmount } = await render(<PlayerAvatar player={player(path)} />);

      // The important half: no `<img>` is produced at all, so there is no
      // request to a host somebody else chose.
      expect(container.querySelector('img'), path).toBeNull();
      expect(container.textContent, path).toContain('SO');
      unmount();
    }
  });

  it('never puts the rejected value anywhere in the DOM', async () => {
    const { container, unmount } = await render(
      <PlayerAvatar player={player('https://cdn.elsewhere.test/sam.jpg')} />,
    );

    expect(container.innerHTML).not.toContain('elsewhere.test');
    unmount();
  });
});

describe('a broken image', () => {
  it('falls back to initials rather than a broken-image glyph', async () => {
    const { container, unmount } = await render(<PlayerAvatar player={player(PATH)} />);

    await fire(container.querySelector('img')!, new Event('error'));

    // A deleted object, or a CDN hiccup. Half a roster showing broken-image
    // icons reads as a fault in Matchday.
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('SO');
    unmount();
  });

  it('regains its accessible name after the fallback', async () => {
    const { container, unmount } = await render(<PlayerAvatar player={player(PATH)} />);

    await fire(container.querySelector('img')!, new Event('error'));

    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      'Sam Okafor, no profile photo',
    );
    unmount();
  });
});

describe('what the component cannot be told', () => {
  it('accepts only two names and a path', async () => {
    // A compile-time guarantee, asserted at runtime as documentation: the prop
    // type has no `profile_photo_url`, so a legacy address cannot reach another
    // member's browser through any of the nine surfaces that render this. The
    // `as never` is the point — TypeScript rejects the extra key without it.
    const withLegacy = {
      first_name: 'Sam',
      last_name: 'Okafor',
      profile_photo_path: null,
      profile_photo_url: 'https://cdn.elsewhere.test/sam.jpg',
    } as never;

    const { container, unmount } = await render(<PlayerAvatar player={withLegacy} />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('elsewhere.test');
    expect(container.textContent).toContain('SO');
    unmount();
  });

  it('falls back to a placeholder initial when there is no name', async () => {
    const { container, unmount } = await render(
      <PlayerAvatar player={{ first_name: '', last_name: '', profile_photo_path: null }} />,
    );

    expect(container.textContent).toContain('?');
    unmount();
  });
});
