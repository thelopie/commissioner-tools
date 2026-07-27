import { z } from 'zod';

/**
 * The persistence firewall.
 *
 * Yahoo's API Terms of Use require removing Yahoo user data within 24 hours
 * unless it is explicitly identified as storable indefinitely. Two values
 * qualify: the Yahoo GUID and token values. Everything else Yahoo returns —
 * team names, manager nicknames, scores, rosters, statistics — may only live in
 * the TTL'd cache.
 *
 * A comment saying so would rot. Instead, `assertNoYahooDerivedFields` walks a
 * schema and fails if a persisted entity has grown a field that looks like
 * retained Yahoo content. It runs as a unit test over every persisted entity, so
 * adding `yahooTeamName` to a record breaks the build rather than shipping a
 * policy violation.
 *
 * @see https://legal.yahoo.com/us/en/yahoo/terms/product-atos/apiforydn/index.html
 */

/**
 * Yahoo-owned field names that must never be persisted.
 *
 * Identifiers are permitted and therefore absent from this list: `yahooGuid`,
 * `yahooGameKey`, `yahooLeagueKey`, `yahooTeamKey`. A key lets us re-fetch;
 * it is not a copy of Yahoo's content.
 */
const FORBIDDEN_FIELD_PATTERNS: readonly RegExp[] = [
  // Yahoo-sourced display text. Unanchored suffix matching on purpose, so
  // `fetchedTeamName` and `yahooManagerName` are caught alongside `teamName`.
  /^yahoo.*(name|nickname|label|title)$/i,
  /(team|manager|player)Name$/i,
  /(team|manager|player)Nickname$/i,

  // Scores and statistics
  /^yahoo.*(points|score|stat|stats)$/i,
  /points(For|Against)$/i,
  /^weeklyPoints$/i,
  /^projectedPoints$/i,
  /^playerStats$/i,
  /^teamPoints$/i,

  // Standings and records
  /^(wins|losses|ties)$/i,
  /^standing(s)?$/i,
  /^rank(ing)?$/i,

  // Raw payloads
  /^raw(Yahoo)?(Response|Payload|Body|Json)$/i,
  /^yahooResponse$/i,
  /^roster$/i,
  /^matchup(s)?$/i,
  /^transaction(s)?$/i,
  /^draftResult(s)?$/i,
];

/**
 * Fields that match a forbidden pattern but are legitimately Dinkel-owned.
 *
 * Each entry is a deliberate, reviewed exception rather than a loosened rule.
 * The key is `EntityName.fieldName`.
 */
const ALLOWED_EXCEPTIONS: ReadonlySet<string> = new Set([
  // Dinkel's own name for a manager in a legacy season, typed in or imported
  // from Dinkel's own spreadsheet. Yahoo never supplies this — the field exists
  // precisely so that pre-portal history needs no Yahoo data at all.
  'LeagueMember.legacyManagerName',
]);

export interface FirewallViolation {
  entity: string;
  path: string;
  pattern: string;
}

/** Field names on an object schema, recursing into wrappers and nested objects. */
function collectFieldPaths(schema: z.ZodTypeAny, prefix = '', depth = 0): string[] {
  if (depth > 6) return [];

  const unwrapped = unwrap(schema);

  if (unwrapped instanceof z.ZodObject) {
    const shape = unwrapped.shape as Record<string, z.ZodTypeAny>;
    return Object.entries(shape).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return [path, ...collectFieldPaths(value, path, depth + 1)];
    });
  }

  if (unwrapped instanceof z.ZodUnion || unwrapped instanceof z.ZodDiscriminatedUnion) {
    const options = unwrapped.options as z.ZodTypeAny[];
    return options.flatMap((option) => collectFieldPaths(option, prefix, depth + 1));
  }

  if (unwrapped instanceof z.ZodArray) {
    return collectFieldPaths(unwrapped.element as z.ZodTypeAny, prefix, depth + 1);
  }

  if (unwrapped instanceof z.ZodRecord) {
    return [];
  }

  return [];
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (let i = 0; i < 10; i += 1) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault
    ) {
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current._def.schema as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodBranded) {
      current = current._def.type as z.ZodTypeAny;
      continue;
    }
    break;
  }
  return current;
}

/**
 * Finds fields on a persisted entity schema that would retain Yahoo content.
 *
 * @param entityName - Name used in violation messages and exception lookups.
 * @param schema - The entity's zod schema.
 * @returns Every violation found; empty when the entity is clean.
 */
export function findYahooDerivedFields(
  entityName: string,
  schema: z.ZodTypeAny,
): FirewallViolation[] {
  const violations: FirewallViolation[] = [];

  for (const path of collectFieldPaths(schema)) {
    const leaf = path.split('.').at(-1) ?? path;
    if (ALLOWED_EXCEPTIONS.has(`${entityName}.${path}`)) continue;

    for (const pattern of FORBIDDEN_FIELD_PATTERNS) {
      if (pattern.test(leaf)) {
        violations.push({ entity: entityName, path, pattern: pattern.source });
        break;
      }
    }
  }

  return violations;
}

export class PersistenceFirewallError extends Error {
  constructor(public readonly violations: readonly FirewallViolation[]) {
    super(
      'Persisted entities may not retain Yahoo-derived content ' +
        '(Yahoo API Terms of Use: 24-hour removal). Offending fields:\n' +
        violations.map((v) => `  - ${v.entity}.${v.path} (matched /${v.pattern}/)`).join('\n') +
        '\n\nFetch the value live and cache it under YAHOO_CACHE_MAX_TTL_SECONDS instead, ' +
        'or add a reviewed exception in persistence-firewall.ts if the field is Dinkel-owned.',
    );
    this.name = 'PersistenceFirewallError';
  }
}

/** @throws {PersistenceFirewallError} when any entity would retain Yahoo content. */
export function assertNoYahooDerivedFields(
  entities: ReadonlyArray<{ name: string; schema: z.ZodTypeAny }>,
): void {
  const violations = entities.flatMap(({ name, schema }) => findYahooDerivedFields(name, schema));
  if (violations.length > 0) throw new PersistenceFirewallError(violations);
}
