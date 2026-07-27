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
  type AnnouncementsResponse,
  type AssignmentsResponse,
  type CalculateResponse,
  type DuesResponse,
  type PayoutsResponse,
  type TasksResponse,
  type ChallengeResultsResponse,
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
  dues: (seasonYear: number) => ['dues', seasonYear] as const,
  payouts: (seasonYear: number) => ['payouts', seasonYear] as const,
  tasks: ['tasks'] as const,
  announcements: ['announcements'] as const,
  challengeResults: (seasonYear: number, week: number) =>
    ['challenges', 'results', seasonYear, week] as const,
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

// --------------------------------------------------------------------------
// Weekly challenge results
// --------------------------------------------------------------------------

export function useChallengeResults(
  seasonYear: number | null,
  week: number | null,
): UseQueryResult<ChallengeResultsResponse> {
  return useQuery({
    queryKey: queryKeys.challengeResults(seasonYear ?? 0, week ?? 0),
    queryFn: () =>
      api.get<ChallengeResultsResponse>(`/api/challenges/${seasonYear}/results/${week}`),
    enabled: seasonYear !== null && week !== null,
  });
}

/** Invalidation shared by every result mutation. */
function useResultInvalidation(seasonYear: number | null, week: number | null) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.challengeResults(seasonYear ?? 0, week ?? 0),
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.challenges(seasonYear ?? 0) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.audit });
  };
}

/**
 * Calculates a week's challenges.
 *
 * Everything it returns is provisional: Yahoo issues stat corrections for days
 * after games, so nothing is payable until a commissioner finalizes it.
 */
export function useCalculateChallenges(seasonYear: number | null, week: number | null) {
  const invalidate = useResultInvalidation(seasonYear, week);

  return useMutation({
    mutationFn: () =>
      api.post<CalculateResponse>(`/api/challenges/${seasonYear}/calculate/${week}`, {}),
    onSuccess: invalidate,
  });
}

export function useFinalizeChallenge(seasonYear: number | null, week: number | null) {
  const invalidate = useResultInvalidation(seasonYear, week);

  return useMutation({
    mutationFn: (slug: string) =>
      api.post<{ ok: boolean }>(`/api/challenges/${seasonYear}/finalize/${week}/${slug}`, {}),
    onSuccess: invalidate,
  });
}

/**
 * Overrides a computed result.
 *
 * A reason is required by the API, not merely encouraged: the computed outcome is
 * kept alongside the override so the arithmetic is never just erased.
 */
export function useOverrideChallenge(seasonYear: number | null, week: number | null) {
  const invalidate = useResultInvalidation(seasonYear, week);

  return useMutation({
    mutationFn: (input: {
      slug: string;
      winningLeagueMemberIds: string[];
      winningValue?: number;
      reason: string;
    }) =>
      api.post<{ ok: boolean; overrideId: string }>(
        `/api/challenges/${seasonYear}/override/${week}/${input.slug}`,
        {
          winningLeagueMemberIds: input.winningLeagueMemberIds,
          ...(input.winningValue === undefined ? {} : { winningValue: input.winningValue }),
          reason: input.reason,
        },
      ),
    onSuccess: invalidate,
  });
}

/**
 * Activates blocked challenges whose Yahoo data has since been verified.
 *
 * A definition's status is derived once, when it is seeded, and seeding deliberately
 * never overwrites a commissioner's edits. So the day Yahoo access is approved and
 * `verifiedCapabilities` fills in, thirteen already-stored definitions would sit
 * blocked forever with no way to turn them on. This is that way.
 *
 * The API re-checks the capability matrix on every activation, so this cannot force
 * on a challenge whose data is still unverified.
 */
export function useActivateChallenges(seasonYear: number | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (slugs: string[]) => {
      const activated: string[] = [];
      const refused: Array<{ slug: string; message: string }> = [];

      // Sequential, so a mid-list refusal does not leave the rest in doubt.
      for (const slug of slugs) {
        try {
          await api.put<{ definition: unknown }>(`/api/challenges/${seasonYear}/${slug}`, {
            status: 'active',
          });
          activated.push(slug);
        } catch (error) {
          refused.push({
            slug,
            message: error instanceof Error ? error.message : 'Refused.',
          });
        }
      }

      return { activated, refused };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.challenges(seasonYear ?? 0) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

// --------------------------------------------------------------------------
// Dues and prizes
//
// Records only. The portal notes that money moved somewhere else — it holds no
// funds, moves none, and integrates no payment processor.
// --------------------------------------------------------------------------

export function useDues(seasonYear: number | null): UseQueryResult<DuesResponse> {
  return useQuery({
    queryKey: queryKeys.dues(seasonYear ?? 0),
    queryFn: () => api.get<DuesResponse>(`/api/dues/${seasonYear}`),
    enabled: seasonYear !== null,
  });
}

export function usePayouts(seasonYear: number | null): UseQueryResult<PayoutsResponse> {
  return useQuery({
    queryKey: queryKeys.payouts(seasonYear ?? 0),
    queryFn: () => api.get<PayoutsResponse>(`/api/payouts/${seasonYear}`),
    enabled: seasonYear !== null,
  });
}

export function useSaveDues(seasonYear: number | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      duesRecordId?: string;
      leagueMemberId: string;
      amountOwedCents: number;
      amountPaidCents?: number;
      dueDate?: string;
      method?: string;
      /** Only `waived` or `refunded`; the rest is derived from the amounts. */
      status?: string;
      note?: string;
    }) =>
      api.post<{ dues: unknown }>(`/api/dues/${seasonYear}`, {
        ...(input.duesRecordId === undefined ? {} : { duesRecordId: input.duesRecordId }),
        leagueMemberId: input.leagueMemberId,
        amountOwed: { amountCents: input.amountOwedCents, currency: 'USD' },
        ...(input.amountPaidCents === undefined
          ? {}
          : { amountPaid: { amountCents: input.amountPaidCents, currency: 'USD' } }),
        ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
        ...(input.method === undefined ? {} : { method: input.method }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.note === undefined ? {} : { note: input.note }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.dues(seasonYear ?? 0) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/**
 * Records a prize.
 *
 * Always created deliberately by a person, never generated from a finalized
 * challenge. Auto-creating money records from Yahoo-derived outcomes would make the
 * pipeline look like an automated stakes engine, and it saves nobody any work.
 */
export function useSavePayout(seasonYear: number | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      payoutRecordId?: string;
      leagueMemberId: string;
      reason: string;
      amountCents: number;
      status?: string;
      method?: string;
      week?: number;
      challengeResultId?: string;
      note?: string;
    }) =>
      api.post<{ payout: unknown }>(`/api/payouts/${seasonYear}`, {
        ...(input.payoutRecordId === undefined ? {} : { payoutRecordId: input.payoutRecordId }),
        leagueMemberId: input.leagueMemberId,
        reason: input.reason,
        amount: { amountCents: input.amountCents, currency: 'USD' },
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.method === undefined ? {} : { method: input.method }),
        ...(input.week === undefined ? {} : { week: input.week }),
        ...(input.challengeResultId === undefined
          ? {}
          : { challengeResultId: input.challengeResultId }),
        ...(input.note === undefined ? {} : { note: input.note }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.payouts(seasonYear ?? 0) });
      // Settling a prize locks the challenge result behind it, so results change too.
      void queryClient.invalidateQueries({ queryKey: ['challenges'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

// --------------------------------------------------------------------------
// Commissioner tasks and announcements
// --------------------------------------------------------------------------

export function useTasks(): UseQueryResult<TasksResponse> {
  return useQuery({
    queryKey: queryKeys.tasks,
    queryFn: () => api.get<TasksResponse>('/api/tasks'),
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      title: string;
      detail?: string;
      category: string;
      priority?: string;
      dueDate?: string;
    }) => api.post<{ task: unknown }>('/api/tasks', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
  });
}

export function useUpdateTaskStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { taskId: string; status: string }) =>
      api.put<{ ok: boolean }>(`/api/tasks/${input.taskId}`, { status: input.status }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
  });
}

export function useAnnouncements(): UseQueryResult<AnnouncementsResponse> {
  return useQuery({
    queryKey: queryKeys.announcements,
    queryFn: () => api.get<AnnouncementsResponse>('/api/announcements'),
  });
}

/**
 * Creates an announcement, published or as a draft.
 *
 * Publishing makes it visible in the portal. It sends nothing — no email, no SMS —
 * and the UI says so, because a commissioner who believes a message went out will
 * not tell anyone themselves.
 */
export function useCreateAnnouncement() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { title: string; body: string; publish: boolean; pinned: boolean }) =>
      api.post<{ announcement: unknown }>('/api/announcements', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.announcements });
      void queryClient.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}
