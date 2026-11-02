#!/usr/bin/env node
'use strict';
// Run from the exact release's shell directory with the service environment.
// Read-only: no catalog request, DNS lookup, generation, upload or authorization.
const path = require('node:path');
const {createRequire} = require('node:module');
function inspectMediaConfiguration({env = process.env, requireRelease = createRequire(path.resolve(process.cwd(), 'package.json'))} = {}) {
  let reviewStatus = 'not_configured', reviewCount = 0, taskCount = 0;
  if (env.PT_MEDIA_REVIEW_FILE) {
    try {
      const reviews = requireRelease('./models/reviewed-media-catalog-view.cjs').readHostMediaReviews(env.PT_MEDIA_REVIEW_FILE);
      reviewCount = reviews.length;
      taskCount = reviews.reduce((count, review) => count + review.tasks.length, 0);
      reviewStatus = reviews.length ? 'valid_structure_and_time' : 'empty';
    } catch { reviewStatus = 'invalid_or_expired'; }
  }
  const hosts = String(env.PT_MEDIA_ASSET_HOSTS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  let assetHostsStatus = 'not_configured';
  if (hosts.length) {
    try {
      requireRelease('./media/pinned-asset-fetch.cjs').createPinnedAssetFetch({allowedHosts: hosts});
      assetHostsStatus = 'valid_structure';
    } catch { assetHostsStatus = 'invalid'; }
  }
  const controlledAuthorization = env.PT_CONTROLLED_MEDIA_AUTHORIZATION === '1';
  return {scope: 'host_configuration_only', reviewConfigured: Boolean(env.PT_MEDIA_REVIEW_FILE), reviewStatus, reviewCount, taskCount,
    controlledAuthorization, assetHostsStatus, assetHostCount: hosts.length,
    readyForSameCredentialCatalogReview: reviewStatus === 'valid_structure_and_time' && controlledAuthorization && assetHostsStatus === 'valid_structure',
    runtimeVerified: false, providerCalls: 0};
}
if (require.main === module) {
  try { const result = inspectMediaConfiguration(); console.log(JSON.stringify(result)); process.exitCode = result.readyForSameCredentialCatalogReview ? 0 : 2; }
  catch { console.log(JSON.stringify({scope: 'host_configuration_only', code: 'MEDIA_PREFLIGHT_UNAVAILABLE', providerCalls: 0})); process.exitCode = 1; }
}
module.exports = {inspectMediaConfiguration};
