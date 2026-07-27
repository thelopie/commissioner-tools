/**
 * API client.
 *
 * Same-origin `fetch` with `credentials: 'include'`, so the HttpOnly session
 * cookie travels without any script ever reading it. State-changing requests echo
 * the readable CSRF cookie in a header â€” the double-submit pattern.
 *
 * There is no token handling here at all, deliberately: the Yahoo refresh token
 * never leaves the backend, so the browser has nothing to store, refresh, or leak.
 */
export interface ApiErrorBody {
    error: {
        code: string;
        message: string;
    };
    fieldErrors?: Array<{
        field: string;
        message: string;
    }>;
}
/**
 * A failed request, carrying the backend's stable error code.
 *
 * The code is what the UI branches on â€” `yahoo_needs_reconnect` shows a reconnect
 * prompt, `commissioner_required` explains the permission â€” rather than matching
 * on message text, which would break the moment wording changed.
 */
export declare class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly fieldErrors: Array<{
        field: string;
        message: string;
    }>;
    constructor(status: number, code: string, message: string, fieldErrors?: Array<{
        field: string;
        message: string;
    }>);
    /** True when reconnecting Yahoo is the fix. */
    get needsYahooReconnect(): boolean;
    get isUnauthenticated(): boolean;
    get isPermission(): boolean;
    /** True when retrying later is reasonable. */
    get isTransient(): boolean;
}
export declare const api: {
    get: <T>(path: string) => Promise<T>;
    post: <T>(path: string, body?: unknown) => Promise<T>;
    put: <T>(path: string, body?: unknown) => Promise<T>;
    delete: <T>(path: string) => Promise<T>;
};
export interface SessionResponse {
    authenticated: boolean;
    needsBootstrap: boolean;
    yahooMode: 'mock' | 'live';
    user?: {
        userId: string;
        displayName: string;
        displayNameConfirmed: boolean;
        role: 'commissioner' | 'manager' | 'readonly';
        isPrimaryCommissioner: boolean;
        status: string;
        email?: string;
    } | null;
}
export interface ConnectionResponse {
    connected: boolean;
    status?: 'active' | 'needs_reconnect' | 'revoked';
    yahooMode: 'mock' | 'live';
    lastSuccessAt?: string | null;
    lastFailureAt?: string | null;
    lastFailureReason?: string | null;
    lastRefreshedAt?: string | null;
    refreshTokenRotations?: number;
    grantedScope?: string | null;
    connectedAt?: string;
    capabilityMatrixReviewedAt: string;
}
export interface LeagueOption {
    yahooLeagueKey: string;
    yahooGameKey: string;
    name: string;
    season: number | null;
    teamCount: number | null;
    scoringType: string | null;
    isYahooCommissioner: boolean | null;
    isFinished: boolean | null;
}
export interface LeagueOverview {
    league: {
        leagueId: string;
        name: string;
        currentSeasonYear: number | null;
    };
    linked: boolean;
    yahoo: {
        seasonYear: number;
        yahooLeagueKey: string;
        name: string;
        season: number | null;
        currentWeek: number | null;
        startWeek: number | null;
        endWeek: number | null;
        playoffStartWeek: number | null;
        scoringType: string | null;
        teamCount: number | null;
        draftStatus: string | null;
        teams: Array<{
            yahooTeamKey: string;
            name: string;
            logoUrl: string | null;
            managers: Array<{
                nickname: string;
                isYahooCommissioner: boolean;
                isYou: boolean;
            }>;
            leagueMemberId: string | null;
        }>;
    } | null;
    fetchedAt?: string;
}
export interface CapabilitiesResponse {
    lastReviewedAt: string;
    access: {
        selfService: boolean;
        approvalRequired: boolean;
        defaultPermission: string;
        applicationUrl: string;
    };
    writeOperationsSupported: boolean;
    commissionerActionsSupported: boolean;
    retention: {
        maxRetentionHours: number;
        storableIndefinitely: string[];
    };
    verifiedCapabilities: string[];
    resources: Array<{
        key: string;
        feature: string;
        resource: string;
        method: string;
        confidence: string;
        testStatus: string;
        limitations: string[];
    }>;
}
export interface ChallengeDefinitionSummary {
    challengeDefinitionId: string;
    slug: string;
    name: string;
    description: string;
    status: 'draft' | 'active' | 'blocked' | 'retired';
    blockedReason?: string;
    requiredYahooData: string[];
    benchCounts: boolean;
    decimalsCount: boolean;
    negativesCount: boolean;
    tieBreakers: string[];
    overridePolicy: string;
}
export interface AuditEntry {
    auditLogId: string;
    action: string;
    at: string;
    actorUserId: string | null;
    actorRole: string;
    summary: string;
    targetEntity?: string;
    targetId?: string;
}
//# sourceMappingURL=client.d.ts.map