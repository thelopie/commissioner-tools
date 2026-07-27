import { AppError, roleAtLeast, type PortalRole } from '@dinkel/shared';

/**
 * Backend authorization.
 *
 * Every privileged operation passes through here. The frontend hides controls a
 * user cannot use, but that is presentation: a manager who crafts a request by
 * hand must be refused by the server, so hiding a button is never the security
 * boundary.
 *
 * Portal roles are Dinkel's own. Yahoo commissioner status confers nothing —
 * Yahoo decides who runs the Yahoo league, not who may spend league money or
 * finalize a paid result in this portal.
 */

export interface Principal {
  userId: string;
  role: PortalRole;
  isPrimaryCommissioner: boolean;
  leagueId: string;
  sessionId: string;
}

/**
 * @throws {AppError} `unauthenticated` when no session resolved.
 */
export function requireAuthenticated(principal: Principal | null): Principal {
  if (!principal) throw new AppError('unauthenticated');
  return principal;
}

/**
 * Requires at least the given role.
 *
 * @throws {AppError} `commissioner_required` or `forbidden`
 */
export function requireRole(principal: Principal | null, required: PortalRole): Principal {
  const authenticated = requireAuthenticated(principal);

  if (!roleAtLeast(authenticated.role, required)) {
    throw new AppError(required === 'commissioner' ? 'commissioner_required' : 'forbidden', {
      detail: { requiredRole: required, actualRole: authenticated.role },
    });
  }

  return authenticated;
}

export function requireCommissioner(principal: Principal | null): Principal {
  return requireRole(principal, 'commissioner');
}

/**
 * Requires the primary commissioner specifically.
 *
 * Reserved for actions that must have exactly one owner: transferring primary
 * responsibility, and revoking another commissioner's access. Otherwise two
 * commissioners could revoke each other and leave the league locked out.
 *
 * @throws {AppError} `forbidden`
 */
export function requirePrimaryCommissioner(principal: Principal | null): Principal {
  const commissioner = requireCommissioner(principal);

  if (!commissioner.isPrimaryCommissioner) {
    throw new AppError('forbidden', {
      publicMessage: 'Only the primary commissioner can do this.',
    });
  }

  return commissioner;
}

/**
 * Requires the principal to be acting on their own record, or to be a
 * commissioner acting on someone else's.
 *
 * Lets a manager update their own display name without granting them the ability
 * to rename anyone else.
 *
 * @throws {AppError} `forbidden`
 */
export function requireSelfOrCommissioner(
  principal: Principal | null,
  targetUserId: string,
): Principal {
  const authenticated = requireAuthenticated(principal);

  if (authenticated.userId === targetUserId) return authenticated;
  return requireCommissioner(authenticated);
}

/**
 * Requires the principal to belong to the league being operated on.
 *
 * A guard against a future multi-league deployment leaking across leagues: a
 * commissioner of one league is not a commissioner of another.
 *
 * @throws {AppError} `forbidden`
 */
export function requireLeague(principal: Principal | null, leagueId: string): Principal {
  const authenticated = requireAuthenticated(principal);

  if (authenticated.leagueId !== leagueId) {
    throw new AppError('forbidden', {
      publicMessage: 'You do not have access to that league.',
      detail: { requestedLeagueId: leagueId },
    });
  }

  return authenticated;
}
