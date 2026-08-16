import { describe, expect, it } from 'vitest';
import { Avatar } from '@/components/ui/avatar';
import { fire, render } from './helpers/render';

/**
 * The `Avatar` component's one job: never show nothing, and never show a
 * broken-image glyph.
 *
 * Both matter because half the avatars in a pilot league are legacy addresses
 * pasted years ago into a text field. Some of those hosts are gone. A roster
 * full of broken-image icons reads as a fault in Matchday.
 */
describe('Avatar', () => {
  const IMAGE = 'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/avatars/a/b.jpg';

  it('renders initials when there is no photo', async () => {
    const { container, unmount } = await render(
      <Avatar src={null} initials="SO" label="Sam Okafor" />,
    );

    expect(container.textContent).toContain('SO');
    expect(container.querySelector('img')).toBeNull();
    unmount();
  });

  it('names itself for a screen reader when there is no photo', async () => {
    const { container, unmount } = await render(
      <Avatar src={null} initials="SO" label="Sam Okafor" />,
    );

    const circle = container.querySelector('[role="img"]');
    expect(circle?.getAttribute('aria-label')).toBe('Sam Okafor, no profile photo');
    unmount();
  });

  it('renders the photo when there is one', async () => {
    const { container, unmount } = await render(
      <Avatar src={IMAGE} initials="SO" label="Sam Okafor" />,
    );

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe(IMAGE);
    expect(image?.getAttribute('alt')).toBe('Sam Okafor, profile photo');
    unmount();
  });

  it('does not announce the name twice when a photo is present', async () => {
    const { container, unmount } = await render(
      <Avatar src={IMAGE} initials="SO" label="Sam Okafor" />,
    );

    // The <img> carries the accessible name; the circle around it must not
    // also be a labelled `role="img"`, or the name is read out twice.
    expect(container.querySelectorAll('[role="img"]')).toHaveLength(0);
    unmount();
  });

  it('keeps the initials underneath while the photo loads', async () => {
    const { container, unmount } = await render(
      <Avatar src={IMAGE} initials="SO" label="Sam Okafor" />,
    );

    // Not a styling detail. The initials are the floor: there is no moment,
    // ever, at which the circle is blank.
    expect(container.textContent).toContain('SO');
    unmount();
  });

  it('falls back to initials when the photo fails to load', async () => {
    const { container, unmount } = await render(
      <Avatar src="https://gone.test/missing.jpg" initials="SO" label="Sam Okafor" />,
    );

    const image = container.querySelector('img');
    expect(image).not.toBeNull();

    await fire(image!, new Event('error', { bubbles: false }));

    // The <img> is removed rather than left to render the browser's
    // broken-image glyph.
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('SO');
    unmount();
  });

  it('regains the accessible name after a failed load', async () => {
    const { container, unmount } = await render(
      <Avatar src="https://gone.test/missing.jpg" initials="SO" label="Sam Okafor" />,
    );

    await fire(container.querySelector('img')!, new Event('error'));

    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      'Sam Okafor, no profile photo',
    );
    unmount();
  });

  it('is circular and cannot overflow its own bounds', async () => {
    const { container, unmount } = await render(
      <Avatar src={IMAGE} initials="SO" label="Sam Okafor" size={64} />,
    );

    const circle = container.firstElementChild as HTMLElement;
    expect(circle.className).toContain('rounded-full');
    expect(circle.className).toContain('overflow-hidden');
    // A non-square source must be cropped, not squashed.
    expect(container.querySelector('img')?.className).toContain('object-cover');
    unmount();
  });

  it('honours the requested size', async () => {
    const { container, unmount } = await render(
      <Avatar src={null} initials="SO" label="Sam Okafor" size={32} />,
    );

    const circle = container.firstElementChild as HTMLElement;
    expect(circle.style.width).toBe('32px');
    expect(circle.style.height).toBe('32px');
    unmount();
  });

  it('renders the fallback for an empty string as well as null', async () => {
    const { container, unmount } = await render(
      <Avatar src="" initials="SO" label="Sam Okafor" />,
    );

    // `src=""` on an <img> re-requests the current page in some browsers, so
    // an empty string must be treated as absence rather than as a URL.
    expect(container.querySelector('img')).toBeNull();
    unmount();
  });
});
