import { describe, expect, it } from 'vitest';
import {
  parseGoalkeeperWillingFromForm,
  parsePositionsFromForm,
  profileInputSchema,
  toFieldErrors,
  toProfileUpdate,
} from '@/lib/validation/profile';

const validInput = {
  first_name: 'Jules',
  last_name: 'Okonkwo',
  phone: '',
  gender: '',
  preferred_positions: [],
  goalkeeper_willing: null,
};

describe('profileInputSchema', () => {
  it('accepts a profile with only the required names', () => {
    const result = profileInputSchema.safeParse(validInput);
    expect(result.success).toBe(true);
    expect(result.data?.first_name).toBe('Jules');
  });

  it('trims surrounding whitespace from names', () => {
    const result = profileInputSchema.parse({
      ...validInput,
      first_name: '  Jules  ',
      last_name: '  Okonkwo ',
    });
    expect(result.first_name).toBe('Jules');
    expect(result.last_name).toBe('Okonkwo');
  });

  it('rejects a whitespace-only first name', () => {
    const result = profileInputSchema.safeParse({ ...validInput, first_name: '   ' });
    expect(result.success).toBe(false);
    expect(toFieldErrors(result.error!)['first_name']).toContain('required');
  });

  it('rejects a name longer than the database allows', () => {
    const result = profileInputSchema.safeParse({ ...validInput, last_name: 'x'.repeat(81) });
    expect(result.success).toBe(false);
  });

  it('turns blank optional fields into null rather than empty strings', () => {
    const result = profileInputSchema.parse({ ...validInput, phone: '   ', gender: '' });
    expect(result.phone).toBeNull();
    expect(result.gender).toBeNull();
  });

  it('keeps optional values that are supplied', () => {
    const result = profileInputSchema.parse({
      ...validInput,
      phone: '+1-555-0100',
      gender: 'non-binary',
      goalkeeper_willing: true,
    });
    expect(result.phone).toBe('+1-555-0100');
    expect(result.gender).toBe('non-binary');
    expect(result.goalkeeper_willing).toBe(true);
  });

  it('ignores a submitted photo URL entirely, rather than validating one', () => {
    // The field is gone from the form and from this schema. What matters is
    // not that a bad URL is rejected but that **no** URL, however well-formed,
    // can reach a profile through this path any more — the only way to set a
    // photo is an upload, which writes an object key the server generated.
    const result = profileInputSchema.parse({
      ...validInput,
      profile_photo_url: 'https://attacker.test/tracking-pixel.gif',
    });

    expect(result).not.toHaveProperty('profile_photo_url');
    expect(result).not.toHaveProperty('profile_photo_path');
  });

  it('drops blank and over-long positions instead of failing the whole form', () => {
    const result = profileInputSchema.parse({
      ...validInput,
      preferred_positions: ['Midfield', '   ', 'x'.repeat(41), 'Winger'],
    });
    expect(result.preferred_positions).toEqual(['Midfield', 'Winger']);
  });

  it('rejects more than eight positions, matching the CHECK constraint', () => {
    const result = profileInputSchema.safeParse({
      ...validInput,
      preferred_positions: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
    });
    expect(result.success).toBe(false);
  });
});

describe('toProfileUpdate', () => {
  it('narrows the payload to exactly the user-writable columns', () => {
    const parsed = profileInputSchema.parse(validInput);
    const update = toProfileUpdate(parsed);

    // Identity columns are server-owned: they must not appear in an update
    // built from form input. Neither may either photo column — those are
    // written only by the avatar action, from a path it generated itself.
    expect(Object.keys(update).sort()).toEqual(
      [
        'first_name',
        'gender',
        'goalkeeper_willing',
        'last_name',
        'phone',
        'preferred_positions',
      ].sort(),
    );
    expect(update).not.toHaveProperty('id');
    expect(update).not.toHaveProperty('email_normalized');
    expect(update).not.toHaveProperty('profile_photo_url');
    expect(update).not.toHaveProperty('profile_photo_path');
  });

  it('carries no skill or rating field, per the product decision', () => {
    const update = toProfileUpdate(profileInputSchema.parse(validInput));
    expect(Object.keys(update).some((key) => /skill|rating/i.test(key))).toBe(false);
  });
});

describe('form parsing helpers', () => {
  it('splits a comma-separated positions field', () => {
    const formData = new FormData();
    formData.set('preferred_positions', ' Midfield ,Winger,, Forward ');
    expect(parsePositionsFromForm(formData)).toEqual(['Midfield', 'Winger', 'Forward']);
  });

  it('returns an empty list when positions are absent', () => {
    expect(parsePositionsFromForm(new FormData())).toEqual([]);
  });

  it('reads goalkeeper willingness as a genuine tri-state', () => {
    const yes = new FormData();
    yes.set('goalkeeper_willing', 'yes');
    const no = new FormData();
    no.set('goalkeeper_willing', 'no');
    const unanswered = new FormData();
    unanswered.set('goalkeeper_willing', '');

    expect(parseGoalkeeperWillingFromForm(yes)).toBe(true);
    expect(parseGoalkeeperWillingFromForm(no)).toBe(false);
    // "No answer" must stay null rather than collapsing into false.
    expect(parseGoalkeeperWillingFromForm(unanswered)).toBeNull();
    expect(parseGoalkeeperWillingFromForm(new FormData())).toBeNull();
  });
});
