// Rates, and the one distinction this whole screen is built around.
//
// ── null is not 0 ─────────────────────────────────────────────────────────────
//
// A rate is `number | null`, and the two are different answers to different
// questions:
//
//   null  "I have not set a rate here."  → fall through to the next level down
//                                          (project → client → invoice settings)
//   0     "Bill nothing for this."       → a real, deliberate rate of zero
//
// Conflating them is silent and expensive. A project meant to inherit $150/h
// that gets stored as 0 bills nothing and nobody notices until the invoice; a
// project meant to be free that gets stored as null quietly bills the client
// default instead.
//
// The input therefore round-trips through a *string*, where "" and "0" are
// plainly distinct, and only becomes a number at the moment of the request.
// This mirrors `front/src/pages/ClientsProjectsPage.tsx:27-65`, which is the
// reference implementation of these rules.

import { formatMoney } from '@/lib/money';
import type { Client, Project } from '@/types';

// ── Input ↔ wire ─────────────────────────────────────────────────────────────

/**
 * The field's text as the value to send.
 *
 * An empty box means "inherit" and must go out as an explicit JSON `null`.
 * "0" is a real rate and must survive as `0`.
 */
export function parseRateInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return Number(trimmed);
}

/** The wire value as the field's text. `null` is empty; `0` renders as "0". */
export function rateToInput(rate: number | null): string {
  return rate === null ? '' : String(rate);
}

/**
 * A message when the box holds something unusable, `''` when it is fine.
 *
 * An empty box is always valid — it is how the rate is cleared. `NumberField`
 * already filters the keypad down to digits, one dot and one leading minus, so
 * what survives to here is a half-typed number like "-" or "." rather than
 * letters.
 */
export function rateInputError(raw: string, label: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  return Number.isFinite(Number(trimmed)) ? '' : `${label} must be a number.`;
}

/**
 * Amber, never blocking — CLAUDE.md's no-locking rule.
 *
 * Neither `clients.py` nor `projects.py` validates the sign, and a negative
 * rate is the natural way to write a credit. So this is said out loud and then
 * saved exactly as typed.
 */
export function rateInputWarning(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed < 0
    ? 'Negative rate — this will subtract on an invoice.'
    : '';
}

// ── Saying which of the two is in effect ─────────────────────────────────────
//
// Every place a rate is shown has to answer "and what does that mean?", because
// an empty rate and a zero rate look almost identical in a list and behave
// nothing alike.

/** What a client's own `default_rate` box currently means. */
export function describeClientRate(raw: string, currency: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return 'Empty — no default. Projects with no rate of their own fall back to the invoice settings rate.';
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return '';
  if (parsed === 0) {
    return 'Zero is a real rate — this client bills nothing by default. Clear the box instead to inherit.';
  }
  return `${formatMoney(parsed, currency)} per hour, for every project with no rate of its own.`;
}

/**
 * What a project's own `rate` box currently means, given the client it sits
 * under. `client` is null while the picker is still empty.
 */
export function describeProjectRate(raw: string, client: Client | null): string {
  const currency = client?.currency ?? 'USD';
  const trimmed = raw.trim();

  if (trimmed === '') {
    if (!client) return 'Empty — inherits the rate of whichever client you pick.';
    if (client.default_rate === null) {
      return `Empty — inherits ${client.name}, which has no default rate either, so the invoice settings rate applies.`;
    }
    if (client.default_rate === 0) {
      return `Empty — inherits ${client.name}'s default of zero, so this project bills nothing.`;
    }
    return `Empty — inherits ${client.name}'s default of ${formatMoney(
      client.default_rate,
      currency,
    )} per hour.`;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return '';
  if (parsed === 0) {
    return 'Zero is a real rate — this project bills nothing, overriding the client default. Clear the box instead to inherit.';
  }
  return `${formatMoney(parsed, currency)} per hour, overriding the client default.`;
}

// ── List labels ──────────────────────────────────────────────────────────────

/** The one-line rate summary on a client row. */
export function clientRateLabel(client: Client): string {
  if (client.default_rate === null) return 'No default rate';
  if (client.default_rate === 0) return `${client.currency} 0 — bills nothing`;
  return `${formatMoney(client.default_rate, client.currency)}/h`;
}

/**
 * The one-line rate summary on a project row, which must say whether the
 * figure is the project's own or inherited.
 */
export function projectRateLabel(project: Project, client: Client | null): string {
  const currency = client?.currency ?? 'USD';

  if (project.rate === null) {
    if (!client) return 'Inherits — client missing';
    if (client.default_rate === null) return 'Inherits — no client default';
    if (client.default_rate === 0) return 'Inherits 0 — bills nothing';
    return `Inherits ${formatMoney(client.default_rate, currency)}/h`;
  }

  if (project.rate === 0) return `${currency} 0 — bills nothing`;
  return `${formatMoney(project.rate, currency)}/h`;
}

/**
 * Whether a project row's rate is its own. Drives the chip tone: an inherited
 * rate is quieter than one set here.
 */
export function hasOwnRate(project: Project): boolean {
  return project.rate !== null;
}
