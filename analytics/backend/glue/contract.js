"use strict";
/**
 * 北极星项目 · 胶水层 · 单元 5.1 能力契约落地 —— 契约类型定义（四样 + 输出四类型）
 *
 * 依据：《北极星开发/5-胶水/5.1-能力契约落地.md》
 *   §2  能力四样 Schema（aliases / outputType / schema / deps）
 *   §3  输出四类型 Schema（report / checklist / data / status，严格对齐接口契约 §3.2）
 *
 * 铁律：
 *   1. 契约只定义接口，不实现业务逻辑。
 *   2. 与接口契约 §3 严格一致，不自行扩展顶层字段。
 *   3. 只读红线：deps 恒 mode === "read"，"write" 不允许出现。
 *
 * 本文件仅导出类型，不含任何运行时行为 / 写操作。
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=contract.js.map