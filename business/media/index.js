"use strict";
/**
 * business/media · media.route 基座 skill 入口。
 * - registry.mediaRouteToolDefinition：Shell 层工具定义（供 autoload PROVIDERS 读取）
 * - callMediaRoute / MODEL_ROUTING：PowerTokens 调用层与模型分类映射表
 */
const registry = require("./registry");
const powertokens = require("./powertokens.cjs");

module.exports = {
  registry,
  mediaRouteToolDefinition: registry.mediaRouteToolDefinition,
  TASK_TYPE_ENUM: registry.TASK_TYPE_ENUM,
  callMediaRoute: powertokens.callMediaRoute,
  MODEL_ROUTING: powertokens.MODEL_ROUTING,
  packageName: "business/media",
  slice: "media-route",
};
