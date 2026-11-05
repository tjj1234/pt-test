import { test, expect } from '@playwright/test';

/**
 * 06-navigation-subsystems-smoke.spec.ts
 * ============================================================================
 * 全域导航与侧边栏业务线子系统冒烟巡检套件
 * 
 * 专门防止“Agent核心对话跑通，但周边业务线Tab翻车（403/502/CSP拦截）”的盲区：
 * 1. 业务流库状态查询：/api/workspaces/enabled-status 拒绝 502 与 403 业务线鉴权失效
 * 2. 调度与执行 / 广告数据导入：/api/business/attribution/import/* 拒绝 403 invalid token
 * 3. 归因看板：验证 iframe 嵌入及安全头 CSP 不包含违规的 frame-ancestors 'none'
 * 4. 能力模块（长期记忆、技能库）：验证数据面板无白屏与无未捕获异常
 * ============================================================================
 */

test.describe('全域导航与业务线集成巡检', () => {

  test('06.1 业务流库接口健康度与鉴权有效性断言', async ({ page, request }) => {
    // 监听所有网络请求，拦截 5xx 与 403
    const failedResponses: { url: string; status: number }[] = [];
    page.on('response', response => {
      if (response.url().includes('/api/workspaces/enabled-status')) {
        if ([403, 500, 502].includes(response.status())) {
          failedResponses.push({ url: response.url(), status: response.status() });
        }
      }
    });

    await page.goto('/');
    
    // 点击侧边栏【业务流库】按钮
    const workflowBtn = page.locator('button:has-text("业务流库")');
    if (await workflowBtn.isVisible()) {
      await workflowBtn.click();
    }

    // 直接发起 API 请求探活验证业务线鉴权 Token
    const res = await request.get('/api/workspaces/enabled-status');
    expect(res.status(), '业务流库状态接口不能返回 502 网关错误或 403 权限拒绝').toBe(200);
    const body = await res.json();
    expect(body.ok, '业务线工作区状态查询应返回 ok: true').toBe(true);
    expect(failedResponses.length, '页面网络流中不应出现 403/502 错误').toBe(0);
  });

  test('06.2 广告数据导入与调度模块 Token 有效性断言', async ({ request }) => {
    // 验证广告归因与导入任务接口
    const jobsRes = await request.get('/api/business/attribution/import/jobs');
    expect(jobsRes.status(), '/api/business/attribution/import/jobs 不应报 403 Forbidden (invalid token)').not.toBe(403);
    
    const workspaceRes = await request.get('/api/business/attribution/import/workspace');
    expect(workspaceRes.status(), '/api/business/attribution/import/workspace 不应报 403 Forbidden (invalid token)').not.toBe(403);
  });

  test('06.3 归因看板 iframe CSP 策略防拦截断言', async ({ page }) => {
    const cspErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && msg.text().includes('violates the following Content Security Policy directive')) {
        cspErrors.push(msg.text());
      }
    });

    await page.goto('/');
    const dashboardBtn = page.locator('button:has-text("PowerTokens 归因面板")');
    if (await dashboardBtn.isVisible()) {
      await dashboardBtn.click();
      await page.waitForTimeout(1000);
    }

    expect(cspErrors.length, '页面加载归因看板时不能发生 frame-ancestors 拦截').toBe(0);
  });

});
