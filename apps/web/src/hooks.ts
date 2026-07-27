import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  api,
  type AuditEntry,
  type CapabilitiesResponse,
  type ChallengeDefinitionSummary,
  type ConnectionResponse,
  type LeagueMembersResponse,
  type LeagueOption,
  type PortalUsersResponse,
  type LeagueOverview,
  type MatchupsResponse,
  type MeResponse,
  type SessionResponse,
  type AssignmentsResponse,
  type DraftStatusResponse,
  type DrawResponse,
  type LLWSTeamsResponse,
  type RosterResponse,
  type SelectionOrderResponse,
  type VerifyDrawResponse,
  type StandingsResponse,
  type TransactionsResponse,
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
  transactions: ['league', 'transactions'] as const,
  roster: (week: number | null) => ['league', 'roster', week] as const,
  portalUsers: ['users'] as const,
  llwsTeams: (seasonYear: number) => ['llws', 'teams', seasonYear] as const,
  assignments: (seasonYear: number) => ['llws', 'assignments', seasonYear] as const,
  verifyDraw: (seasonYear: number) => ['llws', 'verify', seasonYear] as const,
  draftStatus: (seasonYear: number) => ['draft', 'status', seasonYear] as const,
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

export function useTransactions(enabled: boolean): UseQueryResult<TransactionsResponse> {
  return useQuery({
    queryKey: queryKeys.transactions,
    queryFn: () => api.get<TransactionsResponse>('/api/league/transactions'),
    enabled,
  });
}

/**
 * The signed-in user's roster.
 *
 * `week` may be null, in which case the API resolves Yahoo's current week — that
 * avoids a second round trip just to learn which week to ask for.
 */
export function useRoster(enabled: boolean, week: number | null): UseQueryResult<RosterResponse> {
  return useQuery({
    queryKey: queryKeys.roster(week),
    queryFn: () =>
      api.get<RosterResponse>(
        week === null ? '/api/league/roster' : `/api/league/roster?week=${week}`,
      ),
    enabled,
    // Points move during games.
    staleTime: 20_000,
  });
}

// --------------------------------------------------------------------------
// LLWS draft order
// --------------------------------------------------------------------------

export function useLlwsTeams(seasonYear: number | null): UseQueryResult<LLWSTeamsResponse> {
  return useQuery({
    queryKey: queryKeys.llwsTeams(seasonYear ?? 0),
    queryFn: () => api.get<LLWSTeamsResponse>(`/api/llws/${seasonYear}/teams`),
    enabled: seasonYear !== null,
  });
}

export function useAssignments(seasonYear: number | null): UseQueryResult<AssignmentsResponse> {
  return useQuery({
    queryKey: queryKeys.assignments(seasonYear ?? 0),
    queryFn: () => api.get<AssignmentsResponse>(`/api/llws/${seasonYear}/assignments`),
    enabled: seasonYear !== null,
  });
}

/**
 * Re-runs the recorded draw from its stored seed and reports whether it reproduces.
 *
 * Not fetched automatically: it is an audit a person asks for, and running it on
 * every page load would suggest the draw is under suspicion.
 */
export function useVerifyDraw(
  seasonYear: number | null,
  enabled: boolean,
): UseQueryResult<VerifyDrawResponse> {
  return useQuery({
    queryKey: queryKeys.verifyDraw(seasonYear ?? 0),
    queryFn: () => api.get<VerifyDrawResponse>(`/api/llws/${seasonYear}/verify-draw`),
    enabled: seasonYear !== null && enabled,
  });
}

export function useDraftStatus(seasonYear: number | null): UseQueryResult<DraftStatusResponse> {
  return useQuery({
    queryKey: queryKeys.draftStatus(seasonYear ?? 0),
    queryFn: () => api.get<DraftStatusResponse>(`/api/draft/${seasonYear}/status`),
    enabled: seasonYear !== null,
    /**
     * Polled only while a turn is actually open.
     *
     * Managers pick in sequence, often minutes apart, and someone waiting should
     * not have to reload to find out their turn arrived. Outside the draft — which
     * is most of the year — there is nothing to poll for, and this query runs on
     * the home screen too.
     */
    refetchInterval: (query) => (query.state.data?.currentTurn ? 15_000 : false),
  });
}

/** Every draft mutation invalidates the same set, so they share one helper. */
function useDraftMutationKeys(seasonYear: number | null) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.llwsTeams(seasonYear ?? 0) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.assignments(seasonYear ?? 0) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.draftStatus(seasonYear ?? 0) });
    // A stale "verified" badge after a redraw would be actively misleading.
    void queryClient.removeQueries({ queryKey: queryKeys.verifyDraw(seasonYear ?? 0) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.audit });
  };
}

export function useAddLlwsTeams(seasonYear: number | null) {
  const invalidate = useDraftMutationKeys(seasonYear);

  return useMutation({
    mutationFn: (teams: Array<{ name: string; region?: string; bracket: string }>) =>
      api.post<{ llwsTeamIds: string[] }>(`/api/llws/${seasonYear}/teams`, { teams }),
    onSuccess: invalidate,
  });
}

export function useRecordFinish(seasonYear: number | null) {
  const invalidate = useDraftMutationKeys(seasonYear);

  return useMutation({
    mutationFn: (input: { llwsTeamId: string; finishRank: number; finishLabel?: string }) =>
      api.put<{ ok: boolean }>(`/api/llws/${seasonYear}/teams/${input.llwsTeamId}/finish`, {
        finishRank: input.finishRank,
        ...(input.finishLabel === undefined ? {} : { finishLabel: input.finishLabel }),
      }),
    onSuccess: invalidate,
  });
}

export function useDrawAssignments(seasonYear: number | null) {
  const invalidate = useDraftMutationKeys(seasonYear);

  return useMutation({
    mutationFn: (input: { seed?: string; replaceExisting?: boolean }) =>
      api.post<DrawResponse>(`/api/llws/${seasonYear}/draw`, input),
    onSuccess: invalidate,
  });
}

export function usePublishAssignments(seasonYear: number | null) {
  const invalidate = useDraftMutationKeys(seasonYear);

  return useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; publishedAt: string }>(`/api/llws/${seasonYear}/publish`, {}),
    onSuccess: invalidate,
  });
}

export function useComputeSelectionOrder(seasonYear: number | null) {
  const invalidate = useDraftMutationKeys(seasonYear);

  return useMutation({
    mutationFn: (input: { tieBreakers?: string[]; seed?: string }) =>
      api.post<SelectionOrderResponse>(`/api/draft/${seasonYear}/selection-order`, input),
    onSuccess: invalidate,
  });
}

export function useSelectDraftPosition(seasonYear: number | null) {
  const invalidate = useDraftMutationKeys(seasonYear);

  return useMutation({
    mutationFn: (input: { draftPosition: number; leagueMemberId?: string }) =>
      api.post<{ ok: boolean; draftPosition: number; locked: boolean }>(
        `/api/draft/${seasonYear}/select`,
        input,
      ),
    onSuccess: invalidate,
  });
}

export function useRemindCurrentTurn(seasonYear: number | null) {
  const invalidate = useDraftMutationKeys(seasonYear);

  return useMutation({
    mutationFn: () =>
      api.post<{ reminded: boolean; reason?: string; remindersSent?: number }>(
        `/api/draft/${seasonYear}/remind`,
        {},
      ),
    onSuccess: invalidate,
  });
}

// --------------------------------------------------------------------------
// League members
// --------------------------------------------------------------------------

export function useLeagueMembers(seasonYear: number | null): UseQueryResult<LeagueMembersResponse> {
  return useQuery({
    queryKey: queryKeys.members(seasonYear ?? 0),
    queryFn: () =>
      api.get<LeagueMembersResponse>(
        seasonYear === null
          ? '/api/league/members'
          : `/api/league/members?seasonYear=${seasonYear}`,
      ),
    enabled: seasonYear !== null,
  });
}

export function usePortalUsers(): UseQueryResult<PortalUsersResponse> {
  return useQuery({
    queryKey: queryKeys.portalUsers,
    queryFn: () => api.get<PortalUsersResponse>('/api/users'),
  });
}

/**
 * Maps a Yahoo team to a portal member, creating the member if needed.
 *
 * This mapping is what lets league history outlive a Yahoo connection: challenge
 * results and draft records are keyed to the portal member, never to the Yahoo team.
 * Without it the draw and every challenge calculation refuse to run.
 */
export function useMapLeagueMember(seasonYear: number | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      yahooTeamKey?: string;
      userId?: string;
      legacyManagerName?: string;
      leagueMemberId?: string;
    }) => api.post<{ leagueMemberId: string }>('/api/league/members', { seasonYear, ...input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(seasonYear ?? 0) });
      // The overview carries each Yahoo team's leagueMemberId, which just changed.
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      void queryClient.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}
