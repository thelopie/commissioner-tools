import { App, Tags } from 'aws-cdk-lib';
import { readConfig, resourcePrefix } from './config.js';
import { PortalStack } from './portal-stack.js';

/**
 * CDK entry point.
 *
 * Account and region come from the ambient environment (CDK_DEFAULT_*), so the
 * stack synthesizes with no AWS credentials at all — which is what lets CI
 * validate the templates on every push. Deployment picks up whatever profile the
 * operator is using.
 */

const app = new App();
const config = readConfig(app);

const stack = new PortalStack(app, `DinkelPortal-${config.environmentName}`, {
  config,
  env: {
    // Undefined when not deploying. CDK resolves these at deploy time from the
    // active profile, which keeps a specific account out of the repository.
    ...(process.env['CDK_DEFAULT_ACCOUNT'] ? { account: process.env['CDK_DEFAULT_ACCOUNT'] } : {}),
    ...(process.env['CDK_DEFAULT_REGION'] ? { region: process.env['CDK_DEFAULT_REGION'] } : {}),
  },
  description:
    'Dinkel Portal — a private, noncommercial companion application for a Yahoo Fantasy Football ' +
    'league. Not affiliated with Yahoo.',
});

Tags.of(stack).add('Application', 'dinkel-portal');
Tags.of(stack).add('Environment', config.environmentName);
Tags.of(stack).add('ManagedBy', 'aws-cdk');
// Tagged so cost is attributable and a stray resource is identifiable.
Tags.of(stack).add('ResourcePrefix', resourcePrefix(config));

app.synth();
