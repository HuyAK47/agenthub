// Leaf module (no imports) so scheduler, quota and services can use it without import cycles.

interface AccountFields {
  engine: string;
  email: string | null;
}

/** Identity of the provider account behind a profile, or null when the email is unknown. */
export function accountKey(profile: AccountFields): string | null {
  return profile.email ? `${profile.engine}:${profile.email}` : null;
}

/** True when two profiles log in to the same provider account (same engine and email). */
export function sameAccount(a: AccountFields, b: AccountFields): boolean {
  return !!a.email && a.email === b.email && a.engine === b.engine;
}

