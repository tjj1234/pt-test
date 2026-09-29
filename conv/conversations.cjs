"use strict";
/**
 * conversations.cjs —— 兼容转发层（Slice 1.5：消除分叉）
 * ============================================================================
 * v1 多对话（无归档/搜索）已被 conversations-v2.cjs 取代；v2 是 v1 的严格超集
 * （新增 setArchived / search + 每行带 archived），向后兼容。
 * 本文件转发到 v2，作为唯一权威实现。
 * ============================================================================
 */
module.exports = require("./conversations-v2.cjs");
