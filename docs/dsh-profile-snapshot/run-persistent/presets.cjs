"use strict";

/**
 * media.route 风格预设模板。
 *
 * 来源：PicoTrex/Awesome-Nano-Banana-images（GitHub，Apache License 2.0）
 *   https://github.com/PicoTrex/Awesome-Nano-Banana-images
 * 这些提示词原文面向 Google 的 "Nano Banana" 图像生成/编辑模型，
 * 此处仅作为「提示词套路」复用在我们 PowerTokens 目录的文生图模型
 * （seedream-5-0 / qwen-image 等）上，不接入 Google 模型。
 *
 * 每条保留原作者署名与出处链接（见 NOTICE）。
 * 提示词做了少量占位符规范化（统一为 {占位符}），属 Apache-2.0 允许的改作。
 *
 * 范围限制：仓库内容均为图片方向，故仅覆盖文生图 / 图生图两类，
 * 不涉及文生视频 / 图生视频。
 */

const SOURCE_REPO = "https://github.com/PicoTrex/Awesome-Nano-Banana-images";
const LICENSE = "Apache-2.0";

/**
 * 每个预设字段：
 *  - id:        程序内唯一标识（ASCII）
 *  - name:      中文名（用于 stylePreset 枚举与展示）
 *  - taskType:  该模板对应的生成任务类型（text2image / image2image）
 *  - needsImage:是否必须上传参考图
 *  - author:    原作者署名
 *  - source:    原作者出处链接
 *  - hint:      给模型的一句话说明（需要填哪些占位符 / 是否需图）
 *  - template:  提示词模板（{占位符} 待填充）
 */
const STYLE_PRESETS = [
  {
    id: "ukiyoe-card",
    name: "浮世绘闪卡",
    taskType: "text2image",
    needsImage: false,
    author: "@MANISH1027512",
    source: "https://x.com/MANISH1027512/status/1992529793519120763",
    hint: "文生图；填空 {角色名字}/{称号}/{武器描述}/{招式名称}/{视觉特效描述}/{日文汉字名字}",
    template: [
      "一张日式浮世绘风格的收藏级集换式卡牌，竖构图。插画风格紧密模仿《鬼灭之刃》的视觉美学：粗细变化的墨笔轮廓线、传统木版画配色、戏剧性的动态构图。",
      "",
      "主体：卡牌主角是 {角色名字}（称号：{称号}），处于动态战斗姿势，手持 {武器描述}，正在施展 {招式名称}，周围环绕 {视觉特效描述}（例如巨大的火焰 / 水龙 / 旋风），特效以传统日式水墨画（Sumi-e）风格呈现。",
      "",
      "背景与材质：背景融合纹理化的镭射闪卡（Holographic Foil）效果，在传统水墨元素下方闪烁。",
      "",
      "边框：四周为日本传统纹样（青海波或麻叶纹）装饰边框，底部有风格化横幅，用古朴日式书法写着「{日文汉字名字}」。",
    ].join("\n"),
  },
  {
    id: "quote-card",
    name: "金句卡片",
    taskType: "text2image",
    needsImage: false,
    author: "@stark_nico99",
    source: "https://x.com/stark_nico99/status/1991718646570426763",
    hint: "文生图；填空 {金句}/{作者名}",
    template: [
      "一张宽幅名人金句卡，棕色背景，浅金色衬线体大字「{金句}」，下方小字「——{作者名}」。文字前带一个大的淡淡引号。人物头像在左、文字在右，文字占画面约 2/3、人物约 1/3，人物边缘有渐变过渡。",
    ].join("\n"),
  },
  {
    id: "newspaper",
    name: "历史报纸",
    taskType: "text2image",
    needsImage: false,
    author: "@TechieBySA",
    source: "https://x.com/TechieBySA/status/1992901987805835279",
    hint: "文生图；填空 {标题}/{照片描述}",
    template: [
      "一张 1080x1080 像素特写照片，双手捧着一份白色报纸，镜头向下拍摄，背景极度虚化且偏暗，使报纸清晰醒目。报纸占据画面大部分，内容清晰易读，醒目标题为「{标题}」，画面中央是一张 {照片描述} 的大幅黑白照片，配文列数较多、清晰易读。仅更改标题和照片，其余风格、构图、光线、布局与报纸设计保持不变。",
    ].join("\n"),
  },
  {
    id: "city-magnet",
    name: "城市冰箱贴",
    taskType: "text2image",
    needsImage: false,
    author: "@NanoBanana",
    source: "https://x.com/NanoBanana/status/1995921399207100510",
    hint: "文生图；填空 {城市名称}",
    template: [
      "清晰的俯视图：{城市名称} 地标建筑的 3D 磁贴，整齐排列成平行线和直角、呈小山状，是逼真的微缩模型。顶部中央放置一个印有城市名称的纪念磁贴和一张手写便签（写着温度和天气状况），把与当日天气相关的物品融入小山状装饰，所有物品不得重复。",
    ].join("\n"),
  },
  {
    id: "crystal-item",
    name: "水晶质感emoji",
    taskType: "text2image",
    needsImage: false,
    author: "@ZHO_ZHO_ZHO",
    source: "https://x.com/ZHO_ZHO_ZHO/status/1992891830208508130",
    hint: "文生图；填空 {物品名称}（如「一台 3D 拍立得相机」），生成透明玻璃/水晶质感产品图",
    template: [
      "一张照片级真实、细节高度丰富的图像，主体是 {物品名称}，以清澈、抛光度极高的透明玻璃/水晶材质渲染，具有明显厚度与立体深度，边缘圆润倒角、光滑曲面，在光线下产生优雅折射。物体略微倾斜，仿佛漂浮在洁净无缝的淡米白/浅灰棚拍背景上方。",
      "",
      "照明为明亮干净的专业棚拍光，突出玻璃的透明性、镜面反射与折射；倒角、边缘与镜头圆环处呈现锐利高光。光线穿透玻璃内部时产生微妙折射与局部失真，极大增强逼真感。物体下方落一片柔和漫散阴影。整体极简、现代、干净，高调光感与浅景深，主体绝对清晰、背景柔和虚化。",
    ].join("\n"),
  },
  {
    id: "plush-toy",
    name: "蓬松毛绒玩具",
    taskType: "image2image",
    needsImage: true,
    author: "@toolfolio",
    source: "https://x.com/toolfolio/status/1992847853212012705",
    hint: "图生图；需上传参考图（扁平矢量标志），换材质为毛绒",
    template: [
      "将一个简单的扁平矢量标志转换成柔软蓬松的 3D 立体物体，使用原有颜色。该物体完全被毛发覆盖，拥有超逼真的毛发纹理和柔和阴影，位于干净的浅灰色背景中央，轻柔漂浮在空中。风格超现实、触感丰富、现代，摄影棚灯光、高分辨率渲染。",
    ].join("\n"),
  },
  {
    id: "figurine",
    name: "插画变手办",
    taskType: "image2image",
    needsImage: true,
    author: "@ZHO_ZHO_ZHO",
    source: "https://x.com/ZHO_ZHO_ZHO/status/1958539464994959715",
    hint: "图生图；需上传参考图，转为角色手办",
    template: [
      "将这张图片变成角色手办。在它后面放置一个印有角色图像的盒子，盒子上有一台电脑显示 Blender 建模过程；盒子前面添加一个圆形塑料底座，角色手办站在上面。如可能，将场景设置在室内。",
    ].join("\n"),
  },
  {
    id: "photo-colorize",
    name: "旧照片上色",
    taskType: "image2image",
    needsImage: true,
    author: "@GeminiApp",
    source: "https://x.com/GeminiApp/status/1960347483021959197",
    hint: "图生图；需上传老旧照片",
    template: "修复并为这张照片上色",
  },
  {
    id: "instax-photo",
    name: "拍立得照片",
    taskType: "image2image",
    needsImage: true,
    author: "@cheese_ai07",
    source: "https://x.com/cheese_ai07/status/1994662338608161086",
    hint: "图生图；需上传人物参考图，生成 instax mini 拍立得照片",
    template: [
      "请使用附图中的人物，生成一张放在桌面上的 instax mini（Cheki）拍立得照片，完美还原人物的发型、服装和风格。",
      "",
      "竖版矩形（86mm x 54mm），四周白色边框（顶/左/右窄、底部约为顶部两倍宽），图像区竖版 4:3。人物位于画面中心，从头部到膝盖，在白墙前摆出随意偶像姿势，高对比、略泛白的闪光灯直射胶片质感。",
      "",
      "底部留白处手写照片创作日期与人物签名，顶部窄边写一行符合人物性格的日语信息，画面点缀爱心、星星、闪光等可爱涂鸦但不遮挡面部。",
    ].join("\n"),
  },
];

/** 按 id 或 name 查找预设；找不到返回 null。 */
function getStylePreset(idOrName) {
  const q = String(idOrName || "").trim();
  if (!q) return null;
  return (
    STYLE_PRESETS.find((p) => p.id === q || p.name === q) || null
  );
}

/** 供输入 schema 枚举与模型提示使用的精简列表。 */
function listStylePresets() {
  return STYLE_PRESETS.map((p) => ({
    id: p.id,
    name: p.name,
    taskType: p.taskType,
    needsImage: p.needsImage,
    hint: p.hint,
  }));
}

/** 生成一段可贴进工具描述的中文清单。 */
function stylePresetSummary() {
  return STYLE_PRESETS.map((p) => {
    const kind = p.taskType === "text2image" ? "文生图" : "图生图";
    const img = p.needsImage ? "（需上传参考图）" : "";
    return `- ${p.id}「${p.name}」${kind}${img}：${p.hint}`;
  }).join("\n");
}

module.exports = {
  STYLE_PRESETS,
  SOURCE_REPO,
  LICENSE,
  getStylePreset,
  listStylePresets,
  stylePresetSummary,
};
