import type { z } from 'zod';

import { invitationSchema, leagueMemberSchema, portalUserSchema } from './entities/user.js';
import {
  leagueRuleSchema,
  leagueSchema,
  prizeRuleSchema,
  seasonSchema,
  yahooConnectionSchema,
  yahooLeagueLinkSchema,
} from './entities/league.js';
import { duesRecordSchema, payoutRecordSchema } from './entities/money-records.js';
import {
  commissionerOverrideSchema,
  weeklyChallengeDefinitionSchema,
  weeklyChallengeResultSchema,
} from './entities/challenge.js';
import {
  draftPositionSelectionSchema,
  llwsAssignmentSchema,
  llwsTeamSchema,
} from './entities/llws.js';
import {
  announcementSchema,
  commissionerTaskSchema,
  historicalRecordSchema,
  leagueRecapSchema,
} from './entities/ops.js';
import { importBatchSchema, importRowResultSchema } from './entities/import.js';
import { auditLogSchema } from './entities/audit.js';

/**
 * Every entity the portal persists indefinitely.
 *
 * This list is the input to the persistence-firewall test, so a new entity is
 * automatically checked for retained Yahoo content the moment it is registered.
 * Forgetting to register one is caught too: a companion test asserts the count.
 *
 * Note what is absent, deliberately: Player, Roster, Matchup, Transaction,
 * Standings, and weekly player statistics. Those are Yahoo's, fetched on demand
 * and cached under a TTL — never given a permanent entity here.
 */
export const PERSISTED_ENTITIES: ReadonlyArray<{ name: string; schema: z.ZodTypeAny }> = [
  { name: 'PortalUser', schema: portalUserSchema },
  { name: 'LeagueMember', schema: leagueMemberSchema },
  { name: 'Invitation', schema: invitationSchema },
  { name: 'League', schema: leagueSchema },
  { name: 'Season', schema: seasonSchema },
  { name: 'YahooConnection', schema: yahooConnectionSchema },
  { name: 'YahooLeagueLink', schema: yahooLeagueLinkSchema },
  { name: 'LeagueRule', schema: leagueRuleSchema },
  { name: 'PrizeRule', schema: prizeRuleSchema },
  { name: 'DuesRecord', schema: duesRecordSchema },
  { name: 'PayoutRecord', schema: payoutRecordSchema },
  { name: 'WeeklyChallengeDefinition', schema: weeklyChallengeDefinitionSchema },
  { name: 'WeeklyChallengeResult', schema: weeklyChallengeResultSchema },
  { name: 'CommissionerOverride', schema: commissionerOverrideSchema },
  { name: 'LLWSTeam', schema: llwsTeamSchema },
  { name: 'LLWSAssignment', schema: llwsAssignmentSchema },
  { name: 'DraftPositionSelection', schema: draftPositionSelectionSchema },
  { name: 'CommissionerTask', schema: commissionerTaskSchema },
  { name: 'Announcement', schema: announcementSchema },
  { name: 'LeagueRecap', schema: leagueRecapSchema },
  { name: 'HistoricalRecord', schema: historicalRecordSchema },
  { name: 'ImportBatch', schema: importBatchSchema },
  { name: 'ImportRowResult', schema: importRowResultSchema },
  { name: 'AuditLog', schema: auditLogSchema },
];

/** Entity names that must never appear in `PERSISTED_ENTITIES`. */
export const FORBIDDEN_PERSISTED_ENTITIES: readonly string[] = [
  'Player',
  'Roster',
  'RosterSlot',
  'Matchup',
  'Transaction',
  'Standings',
  'Standing',
  'WeeklyPlayerStat',
  'PlayerStat',
  'DraftResult',
  'Scoreboard',
];
