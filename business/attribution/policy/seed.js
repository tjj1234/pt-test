"use strict";
/**
 * 生产不得自动 seed。不修改 analytics/start.cjs；调用方在灌数前必须问这个策略。
 */
function productionSeedPolicy(env = process.env) {
  const production = env.PT_ENV === "production" || env.NODE_ENV === "production";
  const explicit =
    env.PT_ALLOW_DEMO_SEED === "1" || env.PT_ALLOW_DEMO_TENANT === "1";
  if (production) {
    return { production: true, seedAllowed: false, reason: "production_seed_forbidden" };
  }
  if (!explicit) {
    return { production: false, seedAllowed: false, reason: "default_off" };
  }
  return { production: false, seedAllowed: true, reason: "explicit_non_prod" };
}

module.exports = { productionSeedPolicy };
