import { test, expect } from 'e2e';

test.describe('🔴 [P0-5] 错误与降级体验（超时与网关异常）', () => {
  test('模型网关超时或网络故障时，界面呈现可行动的重试/报错提示，严禁界面无限转圈卡死', async ({ app, agent, screen, page }) => {
    await app.open('/');
    await agent.assert('工作区主界面加载正常');

    // 拦截 /api/chat，模拟网关 504 网关超时
    await page.route('**/api/chat', async route => {
      await route.fulfill({
        status: 504,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: 'GATEWAY_TIMEOUT',
          message: '模型服务网关响应超时，本次任务未产生计费，请稍后重试。'
        })
      });
    });

    // 触发提问
    await page.fill('#ta', '请计算这组复杂归因漏斗的转化留存');
    await page.click('#send');

    // 🔴 确定性断言 1：发送按钮必须恢复可用态（或停止按钮隐藏），绝不能卡死在禁用态
    await expect(page.locator('#send')).toBeEnabled({ timeout: 5000 });
    await expect(page.locator('#stop')).toBeHidden();

    // 🔴 确定性断言 2：错误通知区必须展示友好可行动的人话提示
    const notice = page.locator('#composerNotice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/超时.*稍后重试|未产生计费/);
    await expect(notice).not.toContainText('Uncaught (in promise)');
    await expect(notice).not.toContainText('504 Gateway Time-out');
  });
});
