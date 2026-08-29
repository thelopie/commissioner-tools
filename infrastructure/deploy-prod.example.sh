#!/usr/bin/env bash
#
# Deploys the production stack with its domain settings.
#
# Copy this to `deploy-prod.sh` (gitignored) and fill in the three values for your
# account, then deploy with `./deploy-prod.sh` and nothing else.
#
# Why this file exists: the custom domain is opt-in CDK context, read fresh on every
# synth rather than remembered by the deployed stack. Deploy once without these and
# CloudFormation correctly does what the template now says — removes the CloudFront
# alias, deletes the Route 53 record, and resets APP_BASE_URL to its placeholder.
# The site goes dark at its real address and OAuth redirects to the CloudFront
# hostname instead. It is a one-flag mistake with a total outage on the other side,
# so the flags live in a file rather than in somebody's memory.
set -euo pipefail

DOMAIN_NAME="portal.example.com"
HOSTED_ZONE_ID="Z0123456789ABC"
# Must be in us-east-1: CloudFront accepts certificates from nowhere else.
CERTIFICATE_ARN="arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"

cd "$(dirname "$0")"

npx cdk deploy LaLigaDeLopie-prod \
  -c environment=prod \
  -c "domainName=${DOMAIN_NAME}" \
  -c "hostedZoneId=${HOSTED_ZONE_ID}" \
  -c "certificateArn=${CERTIFICATE_ARN}" \
  "$@"

# Worth a glance afterwards: AppUrl should be your domain, not a cloudfront.net
# hostname. If it is the latter, the deploy just took the domain off.
