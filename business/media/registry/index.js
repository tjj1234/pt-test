"use strict";
/**
 * business/media/registry · media.route 注册入口（供 shell autoload 通过
 * definitionGetter "registry.mediaRouteToolDefinition" 读取）。
 */
const { mediaRouteToolDefinition, TASK_TYPE_ENUM } = require("./tool");

module.exports = { mediaRouteToolDefinition, TASK_TYPE_ENUM };
