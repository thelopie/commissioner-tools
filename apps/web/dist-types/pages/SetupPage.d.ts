/**
 * One-time commissioner setup.
 *
 * The first authenticated user claims the league and becomes primary
 * commissioner. Guarded by a conditional write on the backend, so two people
 * running setup simultaneously cannot both succeed.
 */
export declare function SetupPage(): JSX.Element;
//# sourceMappingURL=SetupPage.d.ts.map