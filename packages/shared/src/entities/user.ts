import { z } from 'zod';
import { internalIdSchema, yahooGuidSchema, yahooTeamKeySchema, seasonYearSchema } from '../ids.js';
import { auditableSchema, isoTimestampSchema } from './common.js';

/**
 * Portal roles.
 *
 * Deliberately independent of Yahoo commissioner status. Yahoo tells us who
 * runs the Yahoo league; it does not decide who may spend league money or
 * finalize a challenge result in this portal. A Yahoo commissioner with no
 * portal grant has no portal privileges, and vice versa.
 */
export const portalRoleSchema = z.enum(['commissioner', 'manager', 'readonly']);
export type PortalRole = z.infer<typeof portalRoleSchema>;

/** Ranked so authorization checks can express "at least this much access". */
const ROLE_RANK: Record<PortalRole, number> = {
  readonly: 0,
  manager: 1,
  commissioner: 2,
};

export function roleAtLeast(actual: PortalRole, required: PortalRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export const portalUserSchema = auditableSchema.extend({
  entity: z.literal('PortalUser'),
  userId: internalIdSchema,

  /**
   * Yahoo GUID — the login identity. Storable indefinitely under the Yahoo API
   * Terms of Use, unlike the rest of a Yahoo profile.
   */
  yahooGuid: yahooGuidSchema,

  /**
   * Display name shown throughout the portal and on historical records.
   *
   * Owned by Dinkel, not Yahoo: prefilled from the Yahoo nickname at first
   * sign-in and then confirmed by the user, after which it is our data. This is
   * what lets a 2021 challenge result still render a name after the manager has
   * left the league or the Yahoo connection has lapsed.
   */
  displayName: z.string().min(1).max(80),

  /** True once the user has confirmed (or edited) the prefilled display name. */
  displayNameConfirmed: z.boolean(),

  /** Optional contact address for reminders. Never used to send mail in v1. */
  email: z.string().email().optional(),

  role: portalRoleSchema,

  /**
   * Exactly one user holds primary commissioner responsibility. Additional
   * users may hold the commissioner role; only the primary is the escalation
   * point and the one whose Yahoo connection backs league reads.
   */
  isPrimaryCommissioner: z.boolean(),

  status: z.enum(['active', 'invited', 'disabled']),
  lastSeenAt: isoTimestampSchema.optional(),
});
export type PortalUser = z.infer<typeof portalUserSchema>;

/**
 * Maps a portal user to the Yahoo team they managed in a given season.
 *
 * Season-scoped because managers change teams, teams change names, and rosters
 * turn over. Stores the Yahoo team *key* only — never the Yahoo team name,
 * which is fetched live and cached for at most 24 hours.
 */
export const leagueMemberSchema = auditableSchema.extend({
  entity: z.literal('LeagueMember'),
  leagueMemberId: internalIdSchema,
  leagueId: internalIdSchema,
  seasonYear: seasonYearSchema,

  /** Null for a historical manager who predates the portal and never signed in. */
  userId: internalIdSchema.nullable(),

  /**
   * Manager label for seasons imported from the legacy spreadsheet, where no
   * portal user exists. Dinkel's own data, from Dinkel's own CSV.
   */
  legacyManagerName: z.string().min(1).max(80).optional(),

  /** Yahoo team identifier. Absent for seasons never played on Yahoo. */
  yahooTeamKey: yahooTeamKeySchema.optional(),

  isActive: z.boolean(),
});
export type LeagueMember = z.infer<typeof leagueMemberSchema>;

/**
 * Invitation to join the portal. Redeemed by signing in with Yahoo, at which
 * point the invite's intended role is applied to the new user.
 */
export const invitationSchema = auditableSchema.extend({
  entity: z.literal('Invitation'),
  invitationId: internalIdSchema,
  leagueId: internalIdSchema,
  email: z.string().email(),
  role: portalRoleSchema,
  /** SHA-256 of the invite token. The token itself is never stored. */
  tokenHash: z.string().length(64),
  expiresAt: isoTimestampSchema,
  redeemedAt: isoTimestampSchema.optional(),
  redeemedByUserId: internalIdSchema.optional(),
  status: z.enum(['pending', 'redeemed', 'revoked', 'expired']),
});
export type Invitation = z.infer<typeof invitationSchema>;
