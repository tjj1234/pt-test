import { test, expect } from 'e2e';

test.describe('🔴 [P0-4] 多租户越权防范与未绑 Key 拦截体验', () => {
  test('跨租户篡改 URL 会话 ID 必须严格鉴权拒绝，未绑定 Key 账号给出明确绑定横幅', async ({ app, agent, screen, page }) => {
    // ==========================================
    // 场景 1：未绑定 Key 账号的友好引导拦截
    // ==========================================
    // 模拟后端返回当前用户未绑定 Key 状态
    await page.route('**/api/keys', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, bound: false, hasKey: false })
      });
    });

    await app.open('/');
    
    // 🔴 确定性断言：页面顶部必须弹出未绑定 Key 提示横幅 #keyBanner
    const keyBanner = page.locator('#keyBanner');
    await expect(keyBanner).toBeVisible({ timeout: 5000 });
    await expect(keyBanner).toContainText(/未绑定 PT key.*前往设置/);

    // 点击横幅引导
    await agent.act('点击顶部未绑定 Key 的提示横幅');
    await expect(page).toHaveURL(/.*\/settings/);
    await expect(page.locator('#key')).toBeVisible();

    // ==========================================
    // 场景 2：直接篡改 URL 访问他人的会话 ID（横向越权探测）
    // ==========================================
    // 构造一个不属于当前租户的伪造会话 ID
    const foreignConvId = 'victim-tenant-conversation-99999';

    // 拦截该伪造会话的拉取接口，模拟后端返回 403 / 404
    await page.route(`**/api/conversations/${foreignConvId}`, async route => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: 'FORBIDDEN',
          message: '无权访问该会话或会话属于其他工作区'
        })
      });
    });

    // 尝试直接导航越权 URL
    await app.open(`/?c=${foreignConvId}`);

    // 🔴 确定性断言：聊天区必须保持空态或给出警告，绝不能渲染被篡改会话的历史消息
    const chatContainer = page.locator('#chat');
    await expect(chatContainer).not.toContainText('受害者机密商业数据');
    
    // 应该退回默认的新建对话或首页欢迎态 #hello
    await expect(page.locator('#hello')).toBeVisible();
  });
});
