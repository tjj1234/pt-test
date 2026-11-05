import { test, expect } from 'e2e';

test.describe('🔴 [P0-1] UNKNOWN_MODEL 与失效模型错误人话化', () => {
  test('选择未注册或已失效的模型，界面必须呈现具体、可理解的中文提示，禁止抛出黑盒异常', async ({ app, agent, screen, page }) => {
    // 1. 打开首页并确认界面加载就绪
    await app.open('/');
    await agent.assert('页面正常进入，可以看到侧边栏和主界面');

    // 2. 模拟/注入一个失效或未注册的模型（或通过下拉菜单选择已被下架/未准入的模型）
    // 拦截 /api/chat 请求，并在响应中模拟后端返回 UNKNOWN_MODEL 结构性错误
    await page.route('**/api/chat', async route => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: 'MODEL_UNAVAILABLE',
          code: 'UNKNOWN_MODEL',
          message: '该模型暂不可用或未在该租户下注册，请在模型切换器中选择其他可用模型。',
          fallbackSuggested: true
        })
      });
    });

    // 3. 用户在界面选择模型并发起提问
    await agent.act('点击模型切换按钮 #msBtn');
    await expect(page.locator('#modelMenu')).toBeVisible();

    // 在输入框输入文本并发送
    await agent.act('在输入框 #ta 输入 "你好，请介绍一下你自己" 并点击发送按钮 #send');

    // 4. 关键验证点：人话化错误提示
    // 语义断言：确保 Agent 判定当前不是白屏、不是无意义的技术乱码
    await agent.assert('界面没有卡在"正在连接模型"，并且没有出现通用的 Agent turn ended without completion 报错');

    // 🔴 确定性断言：检查界面上的错误通知区域 #composerNotice 或气泡
    const noticeLocator = page.locator('#composerNotice');
    await expect(noticeLocator).toBeVisible({ timeout: 5000 });
    
    // 必须包含具体可理解的原因和行动建议
    await expect(noticeLocator).toContainText(/暂不可用|未注册|请切换|请选择/);
    
    // 严格否定断言：严禁出现原始系统未捕获错误文本
    await expect(noticeLocator).not.toContainText('Agent turn ended without completion');
    await expect(noticeLocator).not.toContainText('UNKNOWN_MODEL');
    await expect(noticeLocator).not.toContainText('TypeError');
    await expect(noticeLocator).not.toContainText('500 Internal Server Error');
  });
});
