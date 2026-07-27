import type { Construct } from 'constructs';

/**
 * Deployment configuration, read from CDK context.
 *
 * Deliberately account-, region-, and domain-agnostic: the stack synthesizes with
 * no context at all, so CI validates the templates without AWS credentials, and a
 * custom domain is opt-in rather than assumed.
 */

export type EnvironmentName = 'dev' | 'prod';

export interface DeploymentConfig {
  environmentName: EnvironmentName;
  /** True for prod: retain data, longer log retention, stricter defaults. */
  isProduction: boolean;
  /** Custom frontend domain. Absent uses the CloudFront default domain. */
  domainName?: string;
  hostedZoneId?: string;
  certificateArn?: string;
  /** Address for CloudWatch alarms. Absent creates the topic with no subscriber. */
  alertEmail?: string;
}

export function readConfig(scope: Construct): DeploymentConfig {
  const environmentName = (scope.node.tryGetContext('environment') as string | undefined) ?? 'dev';

  if (environmentName !== 'dev' && environmentName !== 'prod') {
    throw new Error(`environment must be "dev" or "prod", got "${environmentName}"`);
  }

  const domainName = optional(scope, 'domainName');
  const hostedZoneId = optional(scope, 'hostedZoneId');
  const certificateArn = optional(scope, 'certificateArn');

  // A half-configured domain would deploy a site nobody can reach, so all three
  // pieces are required together.
  if (domainName && (!hostedZoneId || !certificateArn)) {
    throw new Error(
      'domainName requires hostedZoneId and certificateArn (an ACM certificate in us-east-1). ' +
        'Omit all three to use the default CloudFront domain.',
    );
  }

  return {
    environmentName,
    isProduction: environmentName === 'prod',
    ...(domainName ? { domainName } : {}),
    ...(hostedZoneId ? { hostedZoneId } : {}),
    ...(certificateArn ? { certificateArn } : {}),
    ...(optional(scope, 'alertEmail') ? { alertEmail: optional(scope, 'alertEmail')! } : {}),
  };
}

function optional(scope: Construct, key: string): string | undefined {
  const value = scope.node.tryGetContext(key) as string | undefined;
  return value && value.length > 0 ? value : undefined;
}

/** Resource name prefix, so dev and prod can coexist in one account. */
export function resourcePrefix(config: DeploymentConfig): string {
  return `dinkel-portal-${config.environmentName}`;
}
