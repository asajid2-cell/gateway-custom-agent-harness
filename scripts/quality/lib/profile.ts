/**
 * Profiles decide how tolerant a *run* is, never what the truth is.
 *
 * Every profile reports every finding. Profiles only affect presentation and
 * whether tolerated debt is narrated. There is deliberately no profile that hides
 * a failure, because that would make "passing" depend on who asked.
 */
export type ProfileName = 'research' | 'development' | 'release';

export interface Profile {
  name: ProfileName;
  /** Baseline findings classified as accepted debt are tolerated. */
  tolerateDeclaredDebt: boolean;
  /** Print the full debt list rather than a count. */
  narrateDebt: boolean;
  description: string;
}

export const PROFILES: Record<ProfileName, Profile> = {
  research: {
    name: 'research',
    tolerateDeclaredDebt: true,
    narrateDebt: true,
    description:
      'Snapshot research checkout. Declared stubs are tolerated but always listed.',
  },
  development: {
    name: 'development',
    tolerateDeclaredDebt: true,
    narrateDebt: false,
    description: 'Day-to-day. Declared debt tolerated, not narrated.',
  },
  release: {
    name: 'release',
    tolerateDeclaredDebt: false,
    narrateDebt: true,
    description:
      'Release candidate. Declared debt still does not fail the gate while it is ' +
      'in the baseline, but is reported in full and ratcheted.',
  },
};

export function resolveProfile(name: string): Profile {
  const profile = PROFILES[name as ProfileName];
  if (profile === undefined) {
    throw new Error(
      `unknown profile "${name}"; expected one of ${Object.keys(PROFILES).join(', ')}`
    );
  }
  return profile;
}
