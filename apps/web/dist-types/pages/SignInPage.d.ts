/**
 * Sign-in.
 *
 * The only way in is Yahoo OAuth: the Yahoo GUID is the one Yahoo value the terms
 * permit storing indefinitely, which makes it a natural identity anchor and means
 * this application never stores a password.
 *
 * Portal roles are separate and Dinkel-owned — signing in with Yahoo does not
 * grant commissioner access, even to Yahoo's own league commissioner.
 */
export declare function SignInPage(): JSX.Element;
export declare function describeOAuthError(code: string): {
    severity: 'error' | 'warning' | 'info';
    message: string;
};
//# sourceMappingURL=SignInPage.d.ts.map