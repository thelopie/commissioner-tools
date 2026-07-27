import { AppError, type InternalId } from '@dinkel/shared';
import { createSeededRandom, shuffle } from './random.js';

/**
 * LLWS team assignment.
 *
 * Managers are randomly paired with Little League World Series teams; how far
 * each team advances then decides the order in which managers pick their fantasy
 * draft slot. This module does the draw and enforces that it is one-to-one.
 */

export interface AssignmentInput {
  leagueMemberIds: readonly InternalId[];
  llwsTeamIds: readonly InternalId[];
  /** Recorded with the result so the draw can be re-run and verified. */
  seed: string;
}

export interface Assignment {
  leagueMemberId: InternalId;
  llwsTeamId: InternalId;
}

export interface AssignmentDraw {
  assignments: Assignment[];
  seed: string;
  /** Managers left unassigned because the field was smaller than the league. */
  unassignedLeagueMemberIds: InternalId[];
  /** Teams nobody drew, because the field was larger than the league. */
  unassignedLlwsTeamIds: InternalId[];
}

/**
 * Draws assignments deterministically from the seed.
 *
 * Extra teams are fine — the LLWS field is usually larger than a fantasy league —
 * and are reported rather than silently dropped. Extra managers are also reported
 * rather than assigned nothing quietly, because that is a setup mistake the
 * commissioner needs to see before publishing.
 *
 * @throws {AppError} on duplicate input, which would otherwise produce a draw
 *   that looks valid but assigns one team twice.
 */
export function drawAssignments(input: AssignmentInput): AssignmentDraw {
  assertNoDuplicates(input.leagueMemberIds, 'league member');
  assertNoDuplicates(input.llwsTeamIds, 'LLWS team');

  if (input.seed.trim().length === 0) {
    throw new AppError('validation_failed', {
      publicMessage: 'A randomization seed is required so the draw can be audited later.',
    });
  }

  const random = createSeededRandom(input.seed);

  // Shuffle both sides. Shuffling only the teams would make the result depend on
  // the order managers happen to be listed in, which is not obviously fair.
  const members = shuffle(input.leagueMemberIds, random);
  const teams = shuffle(input.llwsTeamIds, random);

  const pairCount = Math.min(members.length, teams.length);
  const assignments: Assignment[] = [];

  for (let i = 0; i < pairCount; i += 1) {
    assignments.push({ leagueMemberId: members[i]!, llwsTeamId: teams[i]! });
  }

  return {
    assignments,
    seed: input.seed,
    unassignedLeagueMemberIds: members.slice(pairCount),
    unassignedLlwsTeamIds: teams.slice(pairCount),
  };
}

/**
 * Verifies a stored set of assignments is a valid one-to-one mapping.
 *
 * Run before publishing and again before computing draft order. A duplicate here
 * would mean two managers claim the same LLWS finish, which silently corrupts the
 * entire draft order.
 *
 * @throws {AppError} `llws_team_already_assigned` naming the collision.
 */
export function assertAssignmentsUnique(assignments: readonly Assignment[]): void {
  const seenTeams = new Map<InternalId, InternalId>();
  const seenMembers = new Set<InternalId>();

  for (const assignment of assignments) {
    const existingHolder = seenTeams.get(assignment.llwsTeamId);
    if (existingHolder !== undefined) {
      throw new AppError('llws_team_already_assigned', {
        publicMessage: 'One LLWS team is assigned to two managers. Redraw or fix the assignment.',
        detail: {
          llwsTeamId: assignment.llwsTeamId,
          firstLeagueMemberId: existingHolder,
          secondLeagueMemberId: assignment.leagueMemberId,
        },
      });
    }
    seenTeams.set(assignment.llwsTeamId, assignment.leagueMemberId);

    if (seenMembers.has(assignment.leagueMemberId)) {
      throw new AppError('conflict', {
        publicMessage: 'One manager holds two LLWS teams. Redraw or fix the assignment.',
        detail: { leagueMemberId: assignment.leagueMemberId },
      });
    }
    seenMembers.add(assignment.leagueMemberId);
  }
}

/**
 * Re-runs a draw from its recorded seed and confirms it reproduces the stored
 * assignments.
 *
 * This is the audit: if a stored assignment was edited after the draw, this
 * returns false and names the discrepancy.
 */
export function verifyDraw(
  stored: readonly Assignment[],
  input: AssignmentInput,
): { reproduces: boolean; mismatches: Assignment[] } {
  const redrawn = drawAssignments(input);
  const expected = new Map(redrawn.assignments.map((a) => [a.leagueMemberId, a.llwsTeamId]));

  const mismatches = stored.filter(
    (assignment) => expected.get(assignment.leagueMemberId) !== assignment.llwsTeamId,
  );

  return { reproduces: mismatches.length === 0, mismatches };
}

function assertNoDuplicates(ids: readonly InternalId[], label: string): void {
  const seen = new Set<InternalId>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new AppError('duplicate', {
        publicMessage: `The same ${label} appears twice in the draw input.`,
        detail: { duplicateId: id },
      });
    }
    seen.add(id);
  }
}
