import { describe, expect, it, vi } from 'vitest';
import type { ProfileRow } from '@/types/database';
import { render } from './helpers/render';

vi.mock('@/server/actions/profile', () => ({ saveProfileAction: vi.fn() }));

const { ProfileForm } = await import('@/components/profile-form');

/**
 * One regression, stated from the form's own side.
 *
 * `profile-validation.test.ts` proves the schema no longer accepts a photo URL
 * and `avatar-action.test.ts` proves the endpoint ignores one. This proves the
 * field is not in the document either — because a field that still renders is
 * one somebody will fill in, and a form that silently discards what was typed
 * into it is worse than one that never offered the box.
 */

const PROFILE: ProfileRow = {
  id: '11111111-1111-4111-8111-000000000003',
  first_name: 'Sam',
  last_name: 'Okafor',
  email_normalized: 'sam@matchday.test',
  phone: null,
  gender: null,
  preferred_positions: [],
  goalkeeper_willing: null,
  profile_photo_url: 'https://legacy.test/old.jpg',
  profile_photo_path: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  deletion_started_at: null,
  deleted_at: null,
};

describe('ProfileForm', () => {
  it('has no photo URL input, even for a profile that still has one stored', async () => {
    const { container, unmount } = await render(
      <ProfileForm profile={PROFILE} email="sam@matchday.test" submitLabel="Save changes" />,
    );

    expect(container.querySelector('[name="profile_photo_url"]')).toBeNull();
    expect(container.querySelector('[name="profile_photo_path"]')).toBeNull();
    expect(container.querySelector('input[type="url"]')).toBeNull();
    unmount();
  });

  it('does not render the stored legacy address anywhere in the form', async () => {
    const { container, unmount } = await render(
      <ProfileForm profile={PROFILE} email="sam@matchday.test" submitLabel="Save changes" />,
    );

    // It renders as the player's avatar, above this form. It must not also
    // appear as editable text.
    expect(container.innerHTML).not.toContain('legacy.test');
    unmount();
  });

  it('still collects the fields it is responsible for', async () => {
    const { container, unmount } = await render(
      <ProfileForm profile={PROFILE} email="sam@matchday.test" submitLabel="Save changes" />,
    );

    // Removing the photo field must not have removed anything else with it.
    for (const name of [
      'first_name',
      'last_name',
      'phone',
      'gender',
      'preferred_positions',
      'goalkeeper_willing',
    ]) {
      expect(container.querySelector(`[name="${name}"]`), name).not.toBeNull();
    }
    unmount();
  });
});
