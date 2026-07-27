import { type UseQueryResult } from '@tanstack/react-query';
import { type AuditEntry, type CapabilitiesResponse, type ChallengeDefinitionSummary, type ConnectionResponse, type LeagueOption, type LeagueOverview, type SessionResponse } from './api/client.js';
/** Query keys in one place, so invalidation cannot drift from fetching. */
export declare const queryKeys: {
    session: readonly ["session"];
    connection: readonly ["yahoo", "connection"];
    leagues: readonly ["yahoo", "leagues"];
    overview: readonly ["league", "overview"];
    capabilities: readonly ["yahoo", "capabilities"];
    members: (seasonYear: number) => readonly ["league", "members", number];
    challenges: (seasonYear: number) => readonly ["challenges", number];
    audit: readonly ["audit"];
};
export declare function useSession(): UseQueryResult<SessionResponse>;
export declare function useConnection(): UseQueryResult<ConnectionResponse>;
export declare function useYahooLeagues(enabled: boolean): UseQueryResult<{
    leagues: LeagueOption[];
}>;
export declare function useLeagueOverview(enabled: boolean): UseQueryResult<LeagueOverview>;
export declare function useCapabilities(): UseQueryResult<CapabilitiesResponse>;
export declare function useChallenges(seasonYear: number | null): UseQueryResult<{
    definitions: ChallengeDefinitionSummary[];
    blockedCount: number;
}>;
export declare function useAudit(enabled: boolean): UseQueryResult<{
    entries: AuditEntry[];
}>;
/**
 * Forces a fresh read from Yahoo.
 *
 * `refresh=1` bypasses the server-side cache, which is what the dashboard's
 * refresh button is for: a manager who just set their lineup wants to see it now,
 * not in five minutes.
 */
export declare function useManualRefresh(): import("@tanstack/react-query").UseMutationResult<LeagueOverview, Error, void, unknown>;
export declare function useSelectLeague(): import("@tanstack/react-query").UseMutationResult<{
    ok: boolean;
    seasonYear: number;
}, Error, {
    yahooLeagueKey: string;
    yahooGameKey: string;
    seasonYear: number;
}, unknown>;
export declare function useDisconnectYahoo(): import("@tanstack/react-query").UseMutationResult<{
    ok: boolean;
}, Error, void, unknown>;
export declare function useBootstrap(): import("@tanstack/react-query").UseMutationResult<{
    leagueId: string;
    name: string;
}, Error, {
    leagueName: string;
    timezone?: string;
}, unknown>;
export declare function useConfirmDisplayName(userId: string | undefined): import("@tanstack/react-query").UseMutationResult<{
    user: SessionResponse["user"];
}, Error, string, unknown>;
export declare function useSignOut(): import("@tanstack/react-query").UseMutationResult<{
    ok: boolean;
}, Error, void, unknown>;
//# sourceMappingURL=hooks.d.ts.map