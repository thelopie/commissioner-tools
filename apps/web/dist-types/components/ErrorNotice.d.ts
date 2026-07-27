/**
 * Error presentation.
 *
 * Branches on the backend's stable error code rather than on message text, and
 * always offers the specific next step: reconnect Yahoo, ask a commissioner, or
 * retry. "Something went wrong" tells a commissioner nothing they can act on.
 */
export interface ErrorNoticeProps {
    error: unknown;
    onRetry?: () => void;
    /** Suppresses the retry button where retrying makes no sense. */
    hideRetry?: boolean;
}
export declare function ErrorNotice({ error, onRetry, hideRetry }: ErrorNoticeProps): JSX.Element;
/** Small inline reference to the project's data-retention behavior. */
export declare function RetentionNote(): JSX.Element;
//# sourceMappingURL=ErrorNotice.d.ts.map