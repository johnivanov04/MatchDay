import { describe, expect, it } from 'vitest';
import { render } from './helpers/render';

const { PlayerAvatar } = await import('@/components/ui/player-avatar');

/**
 * Another member's avatar, on every shared surface.
 *
 * A profile photo is the one piece of user content in MatchDay that a text
 * filter cannot read, and Guideline 1.2 asks that unmoderated material not be
 * distributed. The member-facing projections already return no photo path for
 * anybody but the viewer; this is the second, independent guarantee — that even
 * when a path IS handed to this component, no image is rendered.
 *
 * It is written as "given a path, still no <img>" on purpose. Asserting only
 * that a null path renders initials would pass just as happily against the old
 * component, and would prove nothing.
 */

describe('PlayerAvatar', () => {
  it('renders initials, not an image, even when given a photo path', async () => {
    const { container, unmount } = await render(
      <PlayerAvatar
        player={{
          first_name: 'Alex',
          last_name: 'Morgan',
          profile_photo_path: '11111111-1111-4111-8111-000000000001/photo.jpg',
        }}
      />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('AM');
    unmount();
  });

  it('never emits the storage path into the markup', async () => {
    const path = '11111111-1111-4111-8111-000000000001/secret-object-key.jpg';
    const { container, unmount } = await render(
      <PlayerAvatar
        player={{ first_name: 'Sam', last_name: 'Kerr', profile_photo_path: path }}
      />,
    );

    expect(container.innerHTML).not.toContain('secret-object-key');
    expect(container.innerHTML).not.toContain('/storage/');
    unmount();
  });

  it('still labels the avatar for a screen reader', async () => {
    const { container, unmount } = await render(
      <PlayerAvatar
        player={{ first_name: 'Sam', last_name: 'Kerr', profile_photo_path: null }}
      />,
    );

    expect(container.textContent).toContain('SK');
    unmount();
  });
});
