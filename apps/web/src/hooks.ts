import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  api,
  type AuditEntry,
  type CapabilitiesResponse,
  type ChallengeDefinitionSummary,
  type ConnectionResponse,
  type LeagueOption,
  type LeagueOverview,
  type MatchupsResponse,
  type MeResponse,
  type SessionResponse,
  type StandingsResponse,
} from './api/client.js';

/** Query keys in one place, so invalidation cannot drift from fetching. */
export const queryKeys = {
  session: ['session'] as const,
  connection: ['yahoo', 'connection'] as const,
  leagues: ['yahoo', 'leagues'] as const,
  overview: ['league', 'overview'] as const,
  capabilities: ['yahoo', 'capabilities'] as const,
  members: (seasonYear: number) => ['league', 'members', seasonYear] as const,
  challenges: (seasonYear: number) => ['challenges', seasonYear] as const,
  audit: ['audit'] as const,
  me: ['league', 'me'] as const,
  standings: ['league', 'standings'] as const,
  matchups: (week: number) => ['league', 'matchups', week] as const,
};

export function useSession(): UseQueryResult<SessionResponse> {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: () => api.get<SessionResponse>('/api/session'),
    // The session drives every route guard, so it must not go stale silently.
    staleTime: 10_000,
  });
}

export function useConnection(): UseQueryResult<ConnectionResponse> {
  return useQuery({
    queryKey: queryKeys.connection,
    queryFn: () => api.get<ConnectionResponse>('/api/yahoo/connection'),
  });
}

export function useYahooLeagues(enabled: boolean): UseQueryResult<{ leagues: LeagueOption[] }> {
  return useQuery({
    queryKey: queryKeys.leagues,
    queryFn: () => api.get<{ leagues: LeagueOption[] }>('/api/yahoo/leagues'),
    enabled,
  });
}

export function useLeagueOverview(enabled: boolean): UseQueryResult<LeagueOverview> {
  return useQuery({
    queryKey: queryKeys.overview,
    queryFn: () => api.get<LeagueOverview>('/api/league/overview'),
    enabled,
  });
}

export function useCapabilities(): UseQueryResult<CapabilitiesResponse> {
  return useQuery({
    queryKey: queryKeys.capabilities,
    queryFn: () => api.get<CapabilitiesResponse>('/api/yahoo/capabilities'),
    // The reviewed matrix changes only when someone edits and redeploys it.
    staleTime: 10 * 60_000,
  });
}

export function useChallenges(
  seasonYear: number | null,
): UseQueryResult<{ definitions: ChallengeDefinitionSummary[]; blockedCount: number }> {
  return useQuery({
    queryKey: queryKeys.challenges(seasonYear ?? 0),
    queryFn: () =>
      api.get<{ definitions: ChallengeDefinitionSummary[]; blockedCount: number }>(
        `/api/challenges/${seasonYear}`,
      ),
    enabled: seasonYear !== null,
  });
}

export function useAudit(enabled: boolean): UseQueryResult<{ entries: AuditEntry[] }> {
  return useQuery({
    queryKey: queryKeys.audit,
    queryFn: () => api.get<{ entries: AuditEntry[] }>('/api/audit?limit=100'),
    enabled,
  });
}

/**
 * Forces a fresh read from Yahoo.
 *
 * `refresh=1` bypasses the server-side cache, which is what the dashboard's
 * refresh button is for: a manager who just set their lineup wants to see it now,
 * not in five minutes.
 */
export function useManualRefresh() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.get<LeagueOverview>('/api/league/overview?refresh=1'),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.overview, data);
      // Connection status carries last-success time, which just changed.
      void queryClient.invalidateQueries({ queryKey: queryKeys.connection });
      // The home summary, standings, and matchups all read the same Yahoo data.
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      void queryClient.invalidateQueries({ queryKey: queryKeys.standings });
      void queryClient.invalidateQueries({ queryKey: ['league', 'matchups'] });
    },
  });
}

export function useSelectLeague() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { yahooLeagueKey: string; yahooGameKey: string; seasonYear: number }) =>
      api.post<{ ok: boolean; seasonYear: number }>('/api/yahoo/league-link', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      void queryClient.invalidateQueries({ queryKey: queryKeys.session });
    },
  });
}

export function useDisconnectYahoo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.delete<{ ok: boolean }>('/api/yahoo/connection'),
    onSuccess: () => {
      // Everything Yahoo-derived is now gone server-side; drop it here too rather
      // than showing data the backend has deleted.
      void queryClient.invalidateQueries({ queryKey: queryKeys.connection });
      queryClient.removeQueries({ queryKey: queryKeys.leagues });
      queryClient.removeQueries({ queryKey: queryKeys.overview });
    },
  });
}

export function useBootstrap() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { leagueName: string; timezone?: string }) =>
      api.post<{ leagueId: string; name: string }>('/api/setup/bootstrap', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.session });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
  });
}

export function useConfirmDisplayName(userId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (displayName: string) =>
      api.put<{ user: SessionResponse['user'] }>(`/api/users/${userId}/display-name`, {
        displayName,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.session });
    },
  });
}

/**
 * Creates the thirteen proposed challenge definitions for a season.
 *
 * Existing definitions are left untouched by the backend, so a commissioner's
 * corrections survive a re-seed.
 */
export function useSeedChallenges(seasonYear: number | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.post<{ seeded: string[]; skipped: string[]; note: string }>(
        `/api/challenges/${seasonYear}/seed`,
        {},
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.challenges(seasonYear ?? 0) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useSignOut() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/api/session/signout'),
    onSuccess: () => {
      // Clear everything: leaving cached league data visible after sign-out would
      // show one user's league to whoever signs in next on a shared device.
      queryClient.clear();
    },
  });
}

export function useLeagueMe(enabled: boolean): UseQueryResult<MeResponse> {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => api.get<MeResponse>('/api/league/me'),
    enabled,
    // Live scores during games, so this should not go stale for long.
    staleTime: 20_000,
  });
}

export function useStandings(enabled: boolean): UseQueryResult<StandingsResponse> {
  return useQuery({
    queryKey: queryKeys.standings,
    queryFn: () => api.get<StandingsResponse>('/api/league/standings'),
    enabled,
  });
}

export function useMatchups(week: number | null): UseQueryResult<MatchupsResponse> {
  return useQuery({
    queryKey: queryKeys.matchups(week ?? 0),
    queryFn: () => api.get<MatchupsResponse>(`/api/league/matchups/${week}`),
    enabled: week !== null,
  });
}
