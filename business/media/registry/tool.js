"use strict";
/**
 * media.route · 基座 shell/tools/registry.cjs#registerTool 的 Tool 定义。
 * 真实执行由 shell 侧 executor 调 business/media/powertokens.cjs#callMediaRoute。
 */
const { PERMISSIONS } = require("../../../shell/permissions/index.cjs");
const { listStylePresets, stylePresetSummary } = require("../presets.cjs");

const TASK_TYPE_ENUM = ["text2image", "image2image", "text2video", "image2video"];
const STYLE_PRESET_ENUM = listStylePresets().map((p) => p.id);

function mediaRouteToolDefinition(overrides = {}) {
  return {
    name: "media.route",
    type: "workflow",
    version: "1.0.0",
    description:
      "根据用户上传的图片和文字描述，选择 PowerTokens 里合适的生成模型（文生图/图生图/文生视频/图生视频），生成并返回结果图片或视频的 URL。",
    inputSchema: {
      type: "object",
      required: ["taskType", "prompt"],
      properties: {
        taskType: {
          type: "string",
          enum: TASK_TYPE_ENUM,
          description:
            "生成任务类型：text2image 文生图 / image2image 图生图 / text2video 文生视频 / image2video 图生视频",
        },
        prompt: {
          type: "string",
          description: "生成提示词（描述要生成的画面 / 视频内容）",
        },
        inputImageUrl: {
          type: "string",
          description:
            "可选：输入图片的可公网访问 URL（http/https）或 data:image/...;base64 数据 URL。图生图 / 图生视频必填。",
        },
        stylePreset: {
          type: "string",
          enum: STYLE_PRESET_ENUM,
          description:
            "可选：风格预设模板 id，仅适用于文生图(text2image)/图生图(image2image)，不支持视频。选择后按模板的提示词套路生成，模板里的占位符内容请写进 prompt；需上传参考图的模板必须同时传 inputImageUrl。可选模板：\n" +
            stylePresetSummary(),
        },
      },
    },
    outputType: "data",
    riskLevel: "write",
    requiredPermissions: [PERMISSIONS.TOOL_USE],
    ...overrides,
  };
}

module.exports = { mediaRouteToolDefinition, TASK_TYPE_ENUM };
