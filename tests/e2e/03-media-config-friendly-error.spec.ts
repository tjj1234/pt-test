import { test, expect } from 'e2e';

test.describe('🔴 [P0-3] 媒体授权配置缺失与协议校验友好指引', () => {
  test('在媒体功能配置缺失或供应商协议未签署时，界面必须呈现精准可行动的引导，禁止泛化模糊报错', async ({ app, agent, screen, page }) => {
    await app.open('/');
    await agent.assert('工作区界面加载正常');

    // 场景 A：模拟受控媒体授权配置缺失（对应 10/30 事故反例）
    await page.route('**/api/chat', async route => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: 'MEDIA_ADMISSION_REJECTED',
          code: 'CONTROLLED_MEDIA_CONFIG_MISSING',
          message: '当前环境的受控媒体生成服务配置尚未就绪（缺少媒体授权配置），请联系管理员开启媒体任务支持。',
          taskType: 'text2video'
        })
      });
    });

    // 选中文生视频
    await agent.act('在输入框上方的生成类型栏 #genType 中，点击"文生视频"按钮');
    await expect(page.locator('#genType .gt-btn[data-type="text2video"]')).toHaveClass(/on/);

    // 触发生成
    await page.fill('#ta', '生成一段出海游戏的 3D 角色战斗预告片');
    await page.click('#send');

    // 🔴 确定性断言：通知区必须明确指出“媒体功能配置”缺失，绝不能混淆为用户Key欠费或泛化的网络错误
    const notice = page.locator('#composerNotice');
    await expect(notice).toBeVisible({ timeout: 5000 });
    await expect(notice).toContainText(/受控媒体|配置尚未就绪|联系管理员/);
    await expect(notice).not.toContainText('500');
    await expect(notice).not.toContainText('网络连接失败');
    await expect(notice).not.toContainText('未知错误');

    // ==========================================
    // 场景 B：模拟 Seedance / 供应商协议未签署引导
    // ==========================================
    await page.route('**/api/chat', async route => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: 'PROVIDER_AGREEMENT_REQUIRED',
          code: 'SEEDANCE_AGREEMENT_PENDING',
          message: '使用该视频生成模型前，需前往供应商平台签署 Seedance 补充协议。',
          actionUrl: 'https://powertokens.example/agreements/seedance'
        })
      });
    });

    await page.fill('#ta', '测试协议拦截');
    await page.click('#send');

    // 🔴 确定性断言：提示文案必须指导用户去签署协议，给出明确行动指引
    await expect(notice).toContainText(/签署.*协议|Seedance/);
  });
});
