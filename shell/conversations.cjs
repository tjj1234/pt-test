"use strict";
/**
 * conversations.cjs —— 兼容转发层（Slice 1.5：消除分叉，不保留旧实现）
 * ============================================================================
 * 权威实现已收敛到 conv/conversations-v2.cjs（多对话 + 归档 setArchived + 搜索 search）。
 * 本文件不再保留旧单对话实现（load/save），只做 require 转发，避免再次分叉。
 *
 * 注意：旧 server.cjs（shell/ 里陈旧的单对话版）若仍调用 conversations.load/save
 *   将失效；当前权威 server（conv/server-v5.cjs）走 v2 接口（list/create/get/rename/
 *   remove/saveMessages/setArchived/search），不受影响。
 * ============================================================================
 */
module.exports = require("../conv/conversations-v2.cjs");
