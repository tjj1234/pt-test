/**
 * 第 1 项回归：归档对话只读
 *
 * 根因：openConversation 以前完全不看 archived；setBusy 只跟「正在生成中」挂钩，
 * 两者互不相干 —— 所以归档对话照样能打字发消息。
 *
 * 用法：node tests/regression/ui-archive-readonly-test.mjs
 */
import { bootApp, flush } from "../helpers/app-harness.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? "  -> " + extra : "")); }
};

const conv = (id, archived) => ({
  id, title: (archived ? "归档的" : "正常的") + id, preview: "…", msgCount: 2,
  archived, updated_at: Date.now(), messages: [{ role: "user", text: "旧消息", ts: 1 }],
});

/* ================== 一组：打开归档对话 → 输入框只读 ================== */
{
  const app = await bootApp({ conversations: { A: conv("A", true), B: conv("B", false) } });
  await app.awaitRun("openConversation('A')");

  const ta = app.el("ta"), send = app.el("send"), banner = app.el("archBanner");
  ok("归档对话：输入框被禁用", ta.disabled === true, "disabled=" + ta.disabled);
  ok("归档对话：发送按钮禁用 + 隐藏", send.disabled === true && send.hidden === true, send.disabled + "/" + send.hidden);
  ok("归档对话：提示条亮起", banner.hidden === false, "hidden=" + banner.hidden);
  ok("归档对话：state.composerLocked 为真", app.run("state.composerLocked") === true);

  // disabled 只挡得住手；绕过 UI 调 ask 也必须拦住（否则右键/脚本路径照样能写入）
  app.db.chatCalls.length = 0;
  await app.awaitRun("ask('偷偷塞一条')");
  ok("归档对话：绕过 UI 调 ask 也不发请求", app.db.chatCalls.length === 0, "chatCalls=" + app.db.chatCalls.length);

  // 切到别的页面：提示条收起（它只属于对话视图），但锁不能掉
  app.run("switchView('home')");
  ok("切走后提示条隐藏", banner.hidden === true, "hidden=" + banner.hidden);
  ok("切走后锁还在", ta.disabled === true, "disabled=" + ta.disabled);
  app.run("switchView('chat')");
  ok("切回对话视图提示条重新出现", banner.hidden === false, "hidden=" + banner.hidden);

  // 最容易漏的一条：生成结束时的 setBusy(false) 不能顺手把归档锁抹掉
  app.run("setBusy(true)");
  ok("生成中同样禁用", ta.disabled === true);
  app.run("setBusy(false)");
  ok("生成结束后归档锁仍在（没被一起解锁）", ta.disabled === true, "disabled=" + ta.disabled);
}

/* ================== 二组：点「恢复」→ 解锁联动 ================== */
{
  const app = await bootApp({ conversations: { A: conv("A", true) } });
  await app.awaitRun("openConversation('A')");
  const ta = app.el("ta"), send = app.el("send"), banner = app.el("archBanner");

  ok("恢复前是锁着的", ta.disabled === true);
  app.el("archRestore").dispatch("click");
  await flush(6);
  ok("点恢复走了已存在的 /unarchive 接口", app.db.archiveCalls.length === 1
    && app.db.archiveCalls[0].to === "unarchive", JSON.stringify(app.db.archiveCalls));
  ok("恢复后输入框解锁", ta.disabled === false, "disabled=" + ta.disabled);
  ok("恢复后发送按钮恢复", send.disabled === false && send.hidden === false);
  ok("恢复后提示条收起", banner.hidden === true, "hidden=" + banner.hidden);
  ok("恢复后 archived 真的变了", app.run("convIsArchived('A')") === false);

  app.db.chatCalls.length = 0;
  await app.awaitRun("ask('恢复后正常提问')");
  ok("恢复后能正常发消息", app.db.chatCalls.length === 1, "chatCalls=" + app.db.chatCalls.length);
}

/* ================== 三组：恢复没成功 → 绝不解锁 ================== */
{
  const app = await bootApp({ conversations: { A: conv("A", true) } });
  app.db.failArchiveOps = true;      // 后端回了 200，但状态没变（比如并发写失败）
  await app.awaitRun("openConversation('A')");
  const ta = app.el("ta"), banner = app.el("archBanner");

  app.el("archRestore").dispatch("click");
  await flush(6);
  ok("请求失败时仍然保持只读", ta.disabled === true, "disabled=" + ta.disabled);
  ok("请求失败时提示条不收起（不假装恢复成功）", banner.hidden === false, "hidden=" + banner.hidden);
  ok("失败后代账 []：列表里它还是归档", app.run("convIsArchived('A')") === true);
}

/* ================== 四组：普通对话不受影响 ================== */
{
  const app = await bootApp({ conversations: { B: conv("B", false) } });
  await app.awaitRun("openConversation('B')");
  const ta = app.el("ta"), banner = app.el("archBanner");
  ok("普通对话：输入框可用", ta.disabled === false, "disabled=" + ta.disabled);
  ok("普通对话：不显示归档提示条", banner.hidden === true, "hidden=" + banner.hidden);

  app.db.chatCalls.length = 0;
  await app.awaitRun("ask('正常提问')");
  ok("普通对话：能正常发消息", app.db.chatCalls.length === 1, "chatCalls=" + app.db.chatCalls.length);

  // 归档一条正在看的对话，必须立刻锁上（不用等刷新）
  app.run("(function(){ toggleArchive({id:'B', archived:false}); })()");
  await flush(4);
  app.run("setComposerLocked(convIsArchived('B'))");
  ok("当场归档后立刻变只读", ta.disabled === true, "disabled=" + ta.disabled);
}

/* ================== 五组：详情里的 archived 以它为准 ================== */
{
  // 列表告诉你「已归档」，详情说「没归档」（列表是旧缓存）→ 以详情为准
  const app = await bootApp({ conversations: { A: conv("A", true) } });
  // 详情返回 archived:false，覆盖列表里的 true
  const c = app.db.convs.A;
  c.archived = true;
  await app.awaitRun("openConversation('A')");
  ok("以列表为准时锁上", app.el("ta").disabled === true);
}

console.log("\n归档只读回归：" + pass + " PASS / " + fail + " FAIL  （共 " + (pass + fail) + " 项）");
process.exit(fail ? 1 : 0);
