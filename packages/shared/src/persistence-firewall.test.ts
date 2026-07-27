import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assertNoYahooDerivedFields,
  findYahooDerivedFields,
  PersistenceFirewallError,
} from './persistence-firewall.js';
import { FORBIDDEN_PERSISTED_ENTITIES, PERSISTED_ENTITIES } from './entity-registry.js';
import {
  assertCacheTtl,
  ttlForResource,
  YAHOO_CACHE_MAX_TTL_SECONDS,
  YAHOO_CACHE_TTL_SECONDS,
  YahooCacheTtlError,
} from './entities/yahoo-cache.js';

describe('persistence firewall', () => {
  it('passes for every registered entity', () => {
    // The real assertion: no entity in the codebase retains Yahoo content.
    // If this fails, read the error — it names the field and the rule.
    expect(() => assertNoYahooDerivedFields(PERSISTED_ENTITIES)).not.toThrow();
  });

  it('registers every entity the product owns', () => {
    // Guards against adding an entity and forgetting to register it, which would
    // silently exempt it from the firewall check above.
    expect(PERSISTED_ENTITIES).toHaveLength(24);
    const names = PERSISTED_ENTITIES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('never registers a raw Yahoo entity', () => {
    const names = new Set(PERSISTED_ENTITIES.map((e) => e.name));
    for (const forbidden of FORBIDDEN_PERSISTED_ENTITIES) {
      expect(names.has(forbidden)).toBe(false);
    }
  });

  it('catches a retained Yahoo team name', () => {
    const schema = z.object({
      entity: z.literal('Bad'),
      yahooTeamKey: z.string(),
      yahooTeamName: z.string(),
    });

    const violations = findYahooDerivedFields('Bad', schema);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('yahooTeamName');
  });

  it('catches retained scores and raw payloads', () => {
    const schema = z.object({
      pointsFor: z.number(),
      rawYahooResponse: z.unknown(),
      playerStats: z.array(z.object({ statId: z.number() })),
    });

    const paths = findYahooDerivedFields('Bad', schema).map((v) => v.path);
    expect(paths).toContain('pointsFor');
    expect(paths).toContain('rawYahooResponse');
    expect(paths).toContain('playerStats');
  });

  it('catches a violation nested inside an optional object', () => {
    const schema = z.object({
      meta: z
        .object({
          teamName: z.string(),
        })
        .optional(),
    });

    expect(findYahooDerivedFields('Bad', schema).map((v) => v.path)).toContain('meta.teamName');
  });

  it('catches a Yahoo name however it is prefixed', () => {
    // Suffix matching, so renaming the field does not slip past the rule.
    const schema = z.object({
      fetchedTeamName: z.string(),
      cachedManagerNickname: z.string(),
    });

    const paths = findYahooDerivedFields('Bad', schema).map((v) => v.path);
    expect(paths).toContain('fetchedTeamName');
    expect(paths).toContain('cachedManagerNickname');
  });

  it('honours a reviewed exception for Dinkel-owned data', () => {
    // legacyManagerName is typed by a commissioner or imported from Dinkel's own
    // spreadsheet — it exists so pre-portal history needs no Yahoo data.
    const schema = z.object({ legacyManagerName: z.string() });

    expect(findYahooDerivedFields('LeagueMember', schema)).toEqual([]);
    // The same field name on any other entity is still a violation.
    expect(findYahooDerivedFields('SomethingElse', schema)).toHaveLength(1);
  });

  it('permits Yahoo identifiers, which are storable and let us re-fetch', () => {
    const schema = z.object({
      yahooGuid: z.string(),
      yahooGameKey: z.string(),
      yahooLeagueKey: z.string(),
      yahooTeamKey: z.string(),
    });

    expect(findYahooDerivedFields('Fine', schema)).toEqual([]);
  });

  it('explains the rule and the remedy when it throws', () => {
    let caught: PersistenceFirewallError | undefined;
    try {
      assertNoYahooDerivedFields([
        { name: 'Bad', schema: z.object({ yahooTeamName: z.string() }) },
      ]);
    } catch (error) {
      caught = error as PersistenceFirewallError;
    }

    expect(caught).toBeInstanceOf(PersistenceFirewallError);
    expect(caught?.message).toContain('Bad.yahooTeamName');
    expect(caught?.message).toContain('24-hour');
    expect(caught?.message).toContain('cache');
  });
});

describe('Yahoo cache TTL ceiling', () => {
  it('caps at 24 hours, the limit the Yahoo terms impose', () => {
    expect(YAHOO_CACHE_MAX_TTL_SECONDS).toBe(86_400);
  });

  it('accepts a TTL at the ceiling', () => {
    expect(assertCacheTtl(YAHOO_CACHE_MAX_TTL_SECONDS)).toBe(86_400);
  });

  it('rejects a TTL past the ceiling instead of quietly clamping it', () => {
    // Silently clamping would hide the caller's wrong assumption.
    expect(() => assertCacheTtl(YAHOO_CACHE_MAX_TTL_SECONDS + 1)).toThrow(YahooCacheTtlError);
    expect(() => assertCacheTtl(48 * 60 * 60)).toThrow(/exceeds/);
  });

  it('rejects nonsensical TTLs', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertCacheTtl(bad)).toThrow(YahooCacheTtlError);
    }
  });

  it('keeps every per-resource TTL under the ceiling', () => {
    for (const [resource, seconds] of Object.entries(YAHOO_CACHE_TTL_SECONDS)) {
      expect(seconds, `${resource} TTL`).toBeLessThanOrEqual(YAHOO_CACHE_MAX_TTL_SECONDS);
      expect(() => ttlForResource(resource as keyof typeof YAHOO_CACHE_TTL_SECONDS)).not.toThrow();
    }
  });

  it('caches live-scoring resources briefly, because stale scores are also wrong', () => {
    expect(YAHOO_CACHE_TTL_SECONDS.scoreboard).toBeLessThanOrEqual(5 * 60);
    expect(YAHOO_CACHE_TTL_SECONDS.roster).toBeLessThanOrEqual(5 * 60);
    expect(YAHOO_CACHE_TTL_SECONDS.player_stats).toBeLessThanOrEqual(5 * 60);
  });
});
