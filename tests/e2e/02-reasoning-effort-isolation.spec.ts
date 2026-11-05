import { test, expect } from 'e2e';

test.describe('🔴 [P0-2] 推理强度与多模型切换参数防残留', () => {
  test('切换模型时，推理档位控件状态严格同步，且发往后端的网络参数绝不跨模型残留', async ({ app, agent, screen, page }) => {
    await app.open('/');
    await agent.assert('成功进入工作区页面');

    let capturedPayloads: Array<{ model?: string; reasoningEffort?: string; prompt?: string }> = [];

    // 拦截发往业务壳的 /api/chat 请求，捕获每次真实请求体
    await page.route('**/api/chat', async route => {
      const postData = route.request().postDataJSON() || {};
      capturedPayloads.push(postData);

      // 返回标准合规的模拟流式响应，保证前端流程正常闭环
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: message\ndata: {"type":"chunk","text":"收到测试指令"}\n\nevent: message\ndata: {"type":"done","completed":true}\n\n'
      });
    });

    // ==========================================
    // 步骤 1：选择支持推理的模型 A，并调节档位至 high
    // ==========================================
    await agent.act('点击切换模型按钮 #msBtn，选择支持推理调节的模型（如带深度思考/reasoning标签的模型）');
    
    // 确定性断言：推理强度控件 #reasoningControl 必须可见并解除隐藏
    const reasoningControl = page.locator('#reasoningControl');
    await expect(reasoningControl).toBeVisible();

    // 调节推理档位为高 (high)
    const reasoningSelect = page.locator('#reasoningSelect');
    await reasoningSelect.selectOption('high');
    await expect(reasoningSelect).toHaveValue('high');

    // 发送第一条消息
    capturedPayloads = [];
    await page.fill('#ta', '测试第一轮：高推理模式');
    await page.click('#send');
    await page.waitForTimeout(500);

    // 🔴 确定性断言：确认 Payload 中正确携带了 high 档位
    expect(capturedPayloads.length).toBeGreaterThan(0);
    const payload1 = capturedPayloads[capturedPayloads.length - 1];
    expect(payload1.reasoningEffort).toBe('high');

    // ==========================================
    // 步骤 2：切换为不支持推理档位的普通文本模型 B
    // ==========================================
    await agent.act('点击切换模型按钮 #msBtn，选择一个不支持深度思考的常规轻量模型');

    // 🔴 确定性断言：推理调节控件必须立即被隐藏或禁用
    await expect(reasoningControl).toBeHidden();

    // 在普通模型下发送第二条消息
    capturedPayloads = [];
    await page.fill('#ta', '测试第二轮：普通文本模式');
    await page.click('#send');
    await page.waitForTimeout(500);

    // 🔴 核心确定性断言：发出的请求绝对不能带有残留的 reasoningEffort 字段！
    expect(capturedPayloads.length).toBeGreaterThan(0);
    const payload2 = capturedPayloads[capturedPayloads.length - 1];
    expect(payload2.reasoningEffort).toBeUndefined();

    // ==========================================
    // 步骤 3：切回模型 A，调为低推理档位 (low)
    // ==========================================
    await agent.act('再次点击模型切换按钮，重新切回支持推理的模型 A');
    await expect(reasoningControl).toBeVisible();

    // 调为低档位
    await reasoningSelect.selectOption('low');
    await expect(reasoningSelect).toHaveValue('low');

    // 发送第三条消息
    capturedPayloads = [];
    await page.fill('#ta', '测试第三轮：低推理模式');
    await page.click('#send');
    await page.waitForTimeout(500);

    // 🔴 确定性断言：发出的请求必须精确反映最新设置的 low 档位，而非旧的 high
    expect(capturedPayloads.length).toBeGreaterThan(0);
    const payload3 = capturedPayloads[capturedPayloads.length - 1];
    expect(payload3.reasoningEffort).toBe('low');
  });
});
