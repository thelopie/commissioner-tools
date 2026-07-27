import { fileURLToPath } from 'node:url';
import {
  aws_apigatewayv2 as apigw,
  aws_apigatewayv2_integrations as integrations,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_dynamodb as dynamodb,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as route53Targets,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
  aws_sqs as sqs,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { resourcePrefix, type DeploymentConfig } from './config.js';

/**
 * The Dinkel Portal stack.
 *
 * One stack, because the pieces share a lifecycle and a ten-person league does not
 * benefit from cross-stack references. Everything is least-privilege by default:
 * the Lambda gets exactly the table, bucket, and secret it needs, and nothing else.
 */

export interface PortalStackProps extends StackProps {
  config: DeploymentConfig;
}

export class PortalStack extends Stack {
  constructor(scope: Construct, id: string, props: PortalStackProps) {
    super(scope, id, props);

    const { config } = props;
    const prefix = resourcePrefix(config);

    // Dev is disposable; prod data is not. Getting this backwards either loses a
    // league's history or leaves orphaned resources behind after every experiment.
    const removalPolicy = config.isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const logRetention = config.isProduction
      ? logs.RetentionDays.SIX_MONTHS
      : logs.RetentionDays.TWO_WEEKS;

    // ------------------------------------------------------------------ table
    const table = new dynamodb.Table(this, 'Table', {
      tableName: prefix,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // AWS-managed encryption at rest. A customer-managed key would add cost and
      // rotation burden without changing the threat model for a private league.
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      /**
       * TTL attribute.
       *
       * This is what enforces the Yahoo 24-hour retention rule at the database
       * level: cache entries and sessions carry `expiresAt`, and DynamoDB removes
       * them without the application having to remember. Application code still
       * checks expiry on read, because TTL deletion is eventual.
       */
      timeToLiveAttribute: 'expiresAt',
      removalPolicy,
    });

    // Sign-in by Yahoo GUID, invite redemption by token hash, import idempotency.
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // "What needs attention": open tasks, unpaid dues, provisional results.
    table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ----------------------------------------------------------------- secrets
    /**
     * Application secrets.
     *
     * Created empty with a generated template so the stack deploys before anyone
     * has Yahoo credentials — which matters here, since Yahoo grants API access
     * only after reviewing an application. Fill it in afterwards; the values are
     * never in the repository or in a CDK context value.
     */
    const secret = new secretsmanager.Secret(this, 'AppSecrets', {
      secretName: `${prefix}/app`,
      description:
        'Dinkel Portal secrets: Yahoo client credentials, session secret, token encryption key, ' +
        'and the optional Anthropic API key for recap prose.',
      generateSecretString: {
        // Session and encryption keys are generated here rather than by a human,
        // so a weak value cannot be chosen by accident.
        secretStringTemplate: JSON.stringify({
          YAHOO_CLIENT_ID: 'replace-me',
          YAHOO_CLIENT_SECRET: 'replace-me',
          ANTHROPIC_API_KEY: '',
        }),
        generateStringKey: 'SESSION_SECRET',
        passwordLength: 44,
        excludePunctuation: true,
      },
      removalPolicy,
    });

    /**
     * Token encryption key, separate from the rest.
     *
     * Rotating it invalidates every stored Yahoo connection and forces reconnects,
     * so it must be rotatable independently of the Yahoo credentials — which
     * rotate for entirely different reasons.
     */
    const tokenKeySecret = new secretsmanager.Secret(this, 'TokenEncryptionKey', {
      secretName: `${prefix}/token-encryption-key`,
      description:
        'AES-256-GCM key for Yahoo tokens at rest. Rotating this forces every user to reconnect.',
      generateSecretString: {
        generateStringKey: 'TOKEN_ENCRYPTION_KEY',
        secretStringTemplate: '{}',
        passwordLength: 44,
        excludePunctuation: true,
      },
      removalPolicy,
    });

    // ---------------------------------------------------------------- buckets
    /**
     * Temporary CSV upload bucket.
     *
     * Encrypted, private, and lifecycle-deleted: an uploaded spreadsheet is needed
     * only long enough to import it, and keeping league financial history in object
     * storage indefinitely serves nobody.
     */
    const importBucket = new s3.Bucket(this, 'ImportBucket', {
      bucketName: `${prefix}-imports-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      lifecycleRules: [
        {
          id: 'delete-temporary-uploads',
          enabled: true,
          // Seven days: long enough to retry a failed import, short enough that a
          // spreadsheet does not linger.
          expiration: Duration.days(7),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy,
      autoDeleteObjects: !config.isProduction,
    });

    const webBucket = new s3.Bucket(this, 'WebBucket', {
      bucketName: `${prefix}-web-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Never public: CloudFront reaches it through Origin Access Control.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy,
      autoDeleteObjects: !config.isProduction,
    });

    // ------------------------------------------------------- dead-letter queue
    /**
     * Dead-letter queue for scheduled jobs.
     *
     * A failed weekly challenge calculation must be replayable: silently dropping
     * it would leave a week with no result and nobody knowing why.
     */
    const deadLetterQueue = new sqs.Queue(this, 'JobDeadLetterQueue', {
      queueName: `${prefix}-job-dlq`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    // ----------------------------------------------------------------- lambda
    const appUrlPlaceholder = config.domainName
      ? `https://${config.domainName}`
      : 'https://REPLACE_AFTER_FIRST_DEPLOY';

    const apiFunction = new nodejs.NodejsFunction(this, 'ApiFunction', {
      functionName: `${prefix}-api`,
      entry: fileURLToPath(new URL('../../apps/api/src/lambda.ts', import.meta.url)),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      // Generous enough for a full-league challenge calculation, which reads one
      // roster per team sequentially to stay gentle on Yahoo's unpublished limits.
      timeout: Duration.seconds(60),
      logGroup: new logs.LogGroup(this, 'ApiLogGroup', {
        logGroupName: `/aws/lambda/${prefix}-api`,
        retention: logRetention,
        removalPolicy,
      }),
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        format: nodejs.OutputFormat.ESM,
        // The AWS SDK is not in the Node 22 managed runtime, so it is bundled.
        // The capability matrix is copied in rather than imported, so the deployed
        // Lambda carries the same reviewed file the repository records.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            process.platform === 'win32'
              ? `copy "${inputDir}\\yahoo-capabilities.json" "${outputDir}"`
              : `cp ${inputDir}/yahoo-capabilities.json ${outputDir}`,
          ],
        },
      },
      environment: {
        NODE_ENV: config.isProduction ? 'production' : 'development',
        AWS_REGION_OVERRIDE: this.region,
        DYNAMODB_TABLE_NAME: table.tableName,
        IMPORT_BUCKET_NAME: importBucket.bucketName,
        APP_BASE_URL: appUrlPlaceholder,
        YAHOO_REDIRECT_URI: `${appUrlPlaceholder}/auth/yahoo/callback`,
        // Live once real credentials are in Secrets Manager. Mock mode is a local
        // development affordance and has no place in a deployed environment.
        YAHOO_MODE: 'live',
        LOG_LEVEL: config.isProduction ? 'info' : 'debug',
        APP_SECRET_ARN: secret.secretArn,
        TOKEN_KEY_SECRET_ARN: tokenKeySecret.secretArn,
        // Secrets are read at cold start, not baked into the function config —
        // environment variables are visible to anyone with lambda:GetFunction.
      },
      deadLetterQueue,
      // One retry, then the DLQ. More would multiply Yahoo requests during an
      // outage, which is the worst moment to be noisy at a rate-limited API.
      retryAttempts: 1,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Least privilege: the specific table and its indexes, and nothing else.
    table.grantReadWriteData(apiFunction);
    importBucket.grantReadWrite(apiFunction);
    importBucket.grantDelete(apiFunction);
    secret.grantRead(apiFunction);
    tokenKeySecret.grantRead(apiFunction);

    // Explicitly deny the destructive table operations the application never
    // performs, so a future code change cannot quietly acquire them.
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ['dynamodb:DeleteTable', 'dynamodb:UpdateTable', 'dynamodb:Scan'],
        resources: [table.tableArn],
      }),
    );

    // ---------------------------------------------------------------- http api
    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `${prefix}-api`,
      // CORS is enforced by the application, which knows the exact allowed origin
      // and must handle credentialed requests. Configuring it here too would give
      // two places to keep in sync.
      createDefaultStage: true,
      defaultIntegration: new integrations.HttpLambdaIntegration('ApiIntegration', apiFunction),
    });

    const apiDomain = `${httpApi.apiId}.execute-api.${this.region}.${this.urlSuffix}`;

    // -------------------------------------------------------------- cloudfront
    /**
     * One distribution serving both the app and the API.
     *
     * Same-origin means the session cookie needs no third-party cookie allowance —
     * which matters, since browsers increasingly block those — and the Yahoo
     * redirect URI is a single stable HTTPS URL.
     */
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${prefix} portal`,
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
          responseHeadersPolicyName: `${prefix}-security-headers`,
          securityHeadersBehavior: {
            contentTypeOptions: { override: true },
            frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
            referrerPolicy: {
              referrerPolicy: cloudfront.HeadersReferrerPolicy.SAME_ORIGIN,
              override: true,
            },
            strictTransportSecurity: {
              accessControlMaxAge: Duration.days(365),
              includeSubdomains: true,
              override: true,
            },
            contentSecurityPolicy: {
              // Self-only, with inline styles allowed because Emotion (MUI's
              // styling engine) injects them at runtime. No external origins:
              // fonts, images, and scripts all ship with the bundle.
              contentSecurityPolicy: [
                "default-src 'self'",
                "script-src 'self'",
                "style-src 'self' 'unsafe-inline'",
                "img-src 'self' data:",
                "font-src 'self' data:",
                "connect-src 'self'",
                "frame-ancestors 'none'",
                "base-uri 'self'",
                "form-action 'self'",
              ].join('; '),
              override: true,
            },
          },
        }),
      },
      additionalBehaviors: {
        // API paths bypass the cache entirely: responses are per-user and
        // per-session, and a shared cache would leak one league's data to another.
        ...apiBehavior('/api/*', apiDomain),
        ...apiBehavior('/auth/*', apiDomain),
        ...apiBehavior('/health', apiDomain),
      },
      errorResponses: [
        // Client-side routing: unknown paths render the app, which then routes.
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      ...(config.domainName && config.certificateArn
        ? {
            domainNames: [config.domainName],
            certificate: acm.Certificate.fromCertificateArn(
              this,
              'Certificate',
              config.certificateArn,
            ),
          }
        : {}),
    });

    if (config.domainName && config.hostedZoneId) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.domainName.split('.').slice(-2).join('.'),
      });

      new route53.ARecord(this, 'AliasRecord', {
        zone,
        recordName: config.domainName,
        target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
      });
    }

    // ------------------------------------------------------ scheduled jobs
    /**
     * Scheduled work.
     *
     * Designed and wired here; the handlers report "not yet implemented" rather
     * than doing partial work. Every schedule targets the same function with a
     * job name, so one Lambda and one set of permissions covers all of them.
     *
     * All of them are idempotent by construction: challenge results are keyed by
     * season/week/slug so recalculating overwrites rather than appends, and system
     * tasks carry an idempotency key so a repeating failure opens one task.
     */
    const jobs: Array<{ id: string; job: string; schedule: events.Schedule; why: string }> = [
      {
        id: 'WeeklyChallengeCalculation',
        job: 'calculate-weekly-challenges',
        // Tuesday 08:00 UTC — after Monday night games have settled.
        schedule: events.Schedule.cron({ minute: '0', hour: '8', weekDay: 'TUE' }),
        why: 'Produce provisional challenge results once the week is played.',
      },
      {
        id: 'StatCorrectionRecalculation',
        job: 'recalculate-after-stat-corrections',
        // Thursday, giving Yahoo time to issue corrections before finalizing.
        schedule: events.Schedule.cron({ minute: '0', hour: '8', weekDay: 'THU' }),
        why: 'Yahoo corrects stats days later, which can change a winner.',
      },
      {
        id: 'WeeklyRecapDraft',
        job: 'draft-weekly-recap',
        schedule: events.Schedule.cron({ minute: '30', hour: '8', weekDay: 'TUE' }),
        why: 'Draft a recap for commissioner review. Never auto-published.',
      },
      {
        id: 'DuesReminders',
        job: 'dues-reminders',
        schedule: events.Schedule.cron({ minute: '0', hour: '13', weekDay: 'MON' }),
        why: 'Surface unpaid dues as commissioner tasks. Sends no messages.',
      },
      {
        id: 'DraftOrderReminders',
        job: 'draft-order-reminders',
        schedule: events.Schedule.cron({ minute: '0', hour: '14' }),
        why: 'Nudge whoever has an open draft-slot turn during draft season.',
      },
      {
        id: 'OAuthHealthCheck',
        job: 'oauth-health-check',
        schedule: events.Schedule.rate(Duration.hours(6)),
        why: 'Detect an expired Yahoo grant before it breaks a scheduled job.',
      },
    ];

    for (const { id, job, schedule, why } of jobs) {
      new events.Rule(this, `${id}Rule`, {
        ruleName: `${prefix}-${job}`,
        description: why,
        schedule,
        targets: [
          new targets.LambdaFunction(apiFunction, {
            event: events.RuleTargetInput.fromObject({
              source: 'scheduled-job',
              job,
              // A correlation ID per execution, so one run is traceable end to end.
              scheduledAt: events.EventField.time,
            }),
            retryAttempts: 2,
            deadLetterQueue,
          }),
        ],
      });
    }

    // ---------------------------------------------------------------- alarms
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${prefix}-alarms`,
      displayName: 'Dinkel Portal alarms',
    });

    if (config.alertEmail) {
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(config.alertEmail));
    }

    const alarms = [
      new cloudwatch.Alarm(this, 'ApiErrorsAlarm', {
        alarmName: `${prefix}-api-errors`,
        alarmDescription: 'The API Lambda is failing.',
        metric: apiFunction.metricErrors({ period: Duration.minutes(5) }),
        threshold: 3,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'ApiThrottlesAlarm', {
        alarmName: `${prefix}-api-throttles`,
        alarmDescription: 'The API Lambda is being throttled.',
        metric: apiFunction.metricThrottles({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'DeadLetterAlarm', {
        alarmName: `${prefix}-job-dlq-not-empty`,
        // The important one: a message here means a scheduled job failed and a
        // week may have no result until someone replays it.
        alarmDescription: 'A scheduled job failed and landed in the dead-letter queue.',
        metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];

    for (const alarm of alarms) {
      alarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
    }

    // --------------------------------------------------------------- outputs
    new CfnOutput(this, 'AppUrl', {
      value: config.domainName
        ? `https://${config.domainName}`
        : `https://${distribution.domainName}`,
      description:
        'Portal URL. Use this as APP_BASE_URL and register the callback below with Yahoo.',
    });

    new CfnOutput(this, 'YahooRedirectUri', {
      value: `${config.domainName ? `https://${config.domainName}` : `https://${distribution.domainName}`}/auth/yahoo/callback`,
      description:
        'Register this EXACT URI on the Yahoo application. It must match character for character.',
    });

    new CfnOutput(this, 'WebBucketName', {
      value: webBucket.bucketName,
      description: 'Sync the built frontend here, then invalidate the distribution.',
    });

    new CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'For cache invalidation after a frontend deploy.',
    });

    new CfnOutput(this, 'AppSecretArn', {
      value: secret.secretArn,
      description: 'Put the Yahoo client ID and secret here after Yahoo approves API access.',
    });

    new CfnOutput(this, 'TableName', { value: table.tableName });

    new CfnOutput(this, 'DeadLetterQueueUrl', {
      value: deadLetterQueue.queueUrl,
      description: 'Failed scheduled jobs land here for manual replay.',
    });
  }
}

/** An uncached, all-methods behavior forwarding everything the API needs. */
function apiBehavior(
  pathPattern: string,
  apiDomain: string,
): Record<string, cloudfront.BehaviorOptions> {
  return {
    [pathPattern]: {
      origin: new origins.HttpOrigin(apiDomain, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      // Never cache an API response: they are per-user and carry Set-Cookie.
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // Forward everything except Host, which must stay the API Gateway host.
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    },
  };
}
