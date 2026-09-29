"use strict";
/**
 * 北极星项目 · 胶水层 · 单元 5.1 能力契约落地 —— 注册校验函数
 *
 * 依据：《北极星开发/5-胶水/5.1-能力契约落地.md》§2.5 校验五条（照做）：
 *   V1 四键齐全：aliases / outputType / schema / deps 缺一 → 拒绝注册
 *   V2 outputType ∈ {report, checklist, data, status}，且 schema === outputType
 *   V3 aliases.id 全局唯一、aliases.list 不跨能力复用
 *   V4 deps 每项 mode === "read"，无写依赖（只读红线）
 *   V5 输出结构套 §3 对应模具（顶层字段一个不多一个不少，见 §3.5）
 *
 * 实现约定：
 *   - V1–V4 是「能力声明」校验，注册时执行（validateTool / ToolRegistry.register）。
 *   - V5 是「输出结构对齐模具」校验，需拿到实际输出值才能比对字段集，
 *     由 validateOutput 在渲染/产出时执行（对齐 §5.2「输出套模具」）。
 *   - 五条各返回明确 REJECT：ok=false 且 issue.rule 标注 V1~V5。
 *
 * 只读铁律：本文件只定义、只校验，不做任何业务写操作。
 *   ToolRegistry 仅在内存登记已注册契约，属胶水簿记，非业务写。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolRegistry = exports.OUTPUT_MOLDS = exports.OUTPUT_TYPES = void 0;
exports.validateTool = validateTool;
exports.validateOutput = validateOutput;
exports.registerTool = registerTool;
/** outputType 枚举值（§2.2）。 */
exports.OUTPUT_TYPES = [
    "report",
    "checklist",
    "data",
    "status",
];
/** 四种模具的顶层字段集（严格对齐 §3.5 / 接口契约 §3.2）。 */
exports.OUTPUT_MOLDS = {
    report: {
        required: ["title", "meta"],
        optional: ["score", "stats", "table", "suggestions"],
    },
    checklist: {
        required: ["title", "meta", "groups"],
        optional: ["note"],
    },
    data: {
        required: ["title", "meta", "rows"],
        optional: ["note"],
    },
    status: {
        required: ["title", "meta", "items"],
        optional: ["note"],
    },
};
function isOutputType(v) {
    return (typeof v === "string" &&
        exports.OUTPUT_TYPES.includes(v));
}
function issue(rule, message) {
    return { rule, message };
}
// ---------------------------------------------------------------------------
// V1：四键齐全（aliases / outputType / schema / deps）
// ---------------------------------------------------------------------------
const REQUIRED_KEYS = ["aliases", "outputType", "schema", "deps"];
function checkV1(contract) {
    if (contract === null || typeof contract !== "object" || Array.isArray(contract)) {
        return [issue("V1", "能力契约必须是对象")];
    }
    const c = contract;
    const issues = [];
    for (const key of REQUIRED_KEYS) {
        if (!(key in c) || c[key] === undefined) {
            issues.push(issue("V1", `四样缺一：缺少键 "${key}"（aliases / outputType / schema / deps 缺一即拒绝注册）`));
        }
    }
    return issues;
}
// ---------------------------------------------------------------------------
// V2：outputType 枚举 + schema === outputType
// ---------------------------------------------------------------------------
function checkV2(contract) {
    const issues = [];
    const outputType = contract["outputType"];
    if (!isOutputType(outputType)) {
        issues.push(issue("V2", `outputType 非法：${JSON.stringify(outputType)}（必须在 report | checklist | data | status 中四选一）`));
        // outputType 非法时 schema === outputType 无从比较，直接返回
        return issues;
    }
    const schema = contract["schema"];
    if (schema !== outputType) {
        issues.push(issue("V2", `schema !== outputType：schema="${String(schema)}" 但 outputType="${outputType}"（一致性冗余被打破）`));
    }
    return issues;
}
// ---------------------------------------------------------------------------
// V3：aliases.id 全局唯一 + aliases.list 不跨能力复用
// ---------------------------------------------------------------------------
function checkV3(contract, registered) {
    const issues = [];
    const aliases = contract["aliases"];
    if (aliases === null || typeof aliases !== "object" || Array.isArray(aliases)) {
        return [issue("V3", "aliases 必须是对象（含 name / id / list）")];
    }
    const a = aliases;
    const id = a["id"];
    if (typeof id !== "string" || id.length === 0) {
        issues.push(issue("V3", "aliases.id 缺失或非空字符串（kebab-case，全局唯一）"));
    }
    const list = a["list"];
    if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) {
        issues.push(issue("V3", "aliases.list 必须是 string[]"));
        return issues;
    }
    // 已注册契约的 id / 别名集合
    const takenIds = new Set();
    const takenAliases = new Set();
    for (const c of registered) {
        takenIds.add(c.aliases.id);
        for (const x of c.aliases.list) {
            takenAliases.add(x);
        }
    }
    if (typeof id === "string" && takenIds.has(id)) {
        issues.push(issue("V3", `aliases.id 全局唯一被打破："${id}" 已被其他能力占用`));
    }
    const seen = new Set();
    for (const x of list) {
        if (takenAliases.has(x)) {
            issues.push(issue("V3", `别名不跨能力复用被打破："${x}" 已被其他能力占用`));
        }
        if (seen.has(x)) {
            issues.push(issue("V3", `本契约内别名重复："${x}"`));
        }
        seen.add(x);
    }
    return issues;
}
// ---------------------------------------------------------------------------
// V4：deps 每项 mode === "read"（只读红线，无写依赖）
// ---------------------------------------------------------------------------
function checkV4(contract) {
    const issues = [];
    const deps = contract["deps"];
    if (!Array.isArray(deps)) {
        return [issue("V4", "deps 必须是数组")];
    }
    deps.forEach((d, i) => {
        if (d === null || typeof d !== "object" || Array.isArray(d)) {
            issues.push(issue("V4", `deps[${i}] 必须是依赖对象（含 type / name / ref / auth / mode）`));
            return;
        }
        const dep = d;
        const mode = dep["mode"];
        if (mode !== "read") {
            issues.push(issue("V4", `deps[${i}] 违反只读红线：mode=${JSON.stringify(mode)}（mode 恒 "read"，出现写依赖即判违例）`));
        }
    });
    return issues;
}
// ---------------------------------------------------------------------------
// validateTool：注册校验（V1–V4 能力声明校验）
// ---------------------------------------------------------------------------
/**
 * 能力契约注册校验（§2.5 校验顺序 1–4）。
 * 校验失败（ok=false）即 REJECT / 拦截，不得注册。
 *
 * @param contract   待注册的能力契约
 * @param registered 已注册契约列表（用于 V3 全局唯一 / 别名不复用）
 */
function validateTool(contract, registered = []) {
    const issues = [];
    issues.push(...checkV1(contract));
    if (contract !== null &&
        typeof contract === "object" &&
        !Array.isArray(contract)) {
        const c = contract;
        issues.push(...checkV2(c));
        issues.push(...checkV3(c, registered));
        issues.push(...checkV4(c));
    }
    return { ok: issues.length === 0, issues };
}
// ---------------------------------------------------------------------------
// validateOutput：输出对齐模具（V5，字段集对齐 §3.5）
// ---------------------------------------------------------------------------
/**
 * 输出结构对齐模具校验（§2.5 校验顺序 5 / §5.2「输出套模具」）。
 * 顶层字段必须匹配 outputType 对应模具，一个不多一个不少。
 * 校验失败（ok=false）即 REJECT / 拦截，不得渲染该输出。
 *
 * @param outputType 能力声明的 outputType（决定套哪个模具）
 * @param output     能力返回的结构化结果
 */
function validateOutput(outputType, output) {
    const issues = [];
    if (!isOutputType(outputType)) {
        return {
            ok: false,
            issues: [issue("V5", `outputType 非法：${JSON.stringify(outputType)}（无法定位模具）`)],
        };
    }
    if (output === null || typeof output !== "object" || Array.isArray(output)) {
        return {
            ok: false,
            issues: [issue("V5", "输出必须是对象（才能套模具）")],
        };
    }
    const obj = output;
    const spec = exports.OUTPUT_MOLDS[outputType];
    const allowed = new Set([...spec.required, ...spec.optional]);
    // 必填顶层字段齐全
    for (const key of spec.required) {
        if (!(key in obj) || obj[key] === undefined) {
            issues.push(issue("V5", `输出缺少必填顶层字段 "${key}"（模具 ${outputType} 要求 ${spec.required.join("/")} 必填）`));
        }
    }
    // 无多余顶层字段（一个不多）
    for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
            issues.push(issue("V5", `输出多出非模具字段 "${key}"（模具 ${outputType} 顶层字段 = ${[...spec.required, ...spec.optional].join("/")}，一个不多一个不少）`));
        }
    }
    // 必填字段类型轻量对齐（§3 字段类型表）
    if ("title" in obj && typeof obj["title"] !== "string") {
        issues.push(issue("V5", "title 必须为 string"));
    }
    if ("meta" in obj && typeof obj["meta"] !== "string") {
        issues.push(issue("V5", "meta 必须为 string"));
    }
    if (outputType === "checklist" && "groups" in obj && !Array.isArray(obj["groups"])) {
        issues.push(issue("V5", "groups 必须为数组"));
    }
    if (outputType === "data" && "rows" in obj && !Array.isArray(obj["rows"])) {
        issues.push(issue("V5", "rows 必须为数组"));
    }
    if (outputType === "status" && "items" in obj && !Array.isArray(obj["items"])) {
        issues.push(issue("V5", "items 必须为数组"));
    }
    return { ok: issues.length === 0, issues };
}
// ---------------------------------------------------------------------------
// ToolRegistry：注册表（registerTool 动作），内存簿记，无业务写
// ---------------------------------------------------------------------------
/**
 * 能力注册表。register() 先过 validateTool（V1–V4），
 * 不过则 REJECT（不登记，返回 issues）；过则登记进内存。
 * 只读铁律：仅内存簿记，不做任何业务写操作。
 */
class ToolRegistry {
    contracts = new Map();
    /** 注册一个能力；REJECT 时不写入注册表。 */
    register(contract) {
        const result = validateTool(contract, this.list());
        if (result.ok) {
            this.contracts.set(contract.aliases.id, contract);
        }
        return result;
    }
    /** 当前已注册契约列表（用于 V3 唯一性对照）。 */
    list() {
        return [...this.contracts.values()];
    }
}
exports.ToolRegistry = ToolRegistry;
/** registerTool 函数：向注册表登记一个能力契约（对齐任务命名）。 */
function registerTool(registry, contract) {
    return registry.register(contract);
}
//# sourceMappingURL=validate.js.map