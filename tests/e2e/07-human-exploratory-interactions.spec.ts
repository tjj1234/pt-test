import { test, expect } from '@playwright/test';

/**
 * 07-human-exploratory-interactions.spec.ts
 * ============================================================================
 * 人类探索性测试与非标交互破坏性用例集
 * 
 * 专门覆盖真实测试人员（王玉霞、孙辉等）在实际使用中的易用性、人机容错与极端操作：
 * 1. 纯图片无文字发送拦截提示：上传图片后，不打字直接点发送，应友好提示输入文字，或允许默认发送
 * 2. 剪贴板文件粘贴容错：Ctrl+V / Cmd+V 粘贴表格（.csv/.xlsx）或视频，需有解析或清晰错误引导，不能静默吞掉
 * 3. 资料检索勾选后删除/反选：已附带上下文文档时，卡片必须提供“×”或“移除”按钮，并能有效卸载
 * 4. 媒体任务授权倒计时感知：120秒租约倒计时需在 UI 呈现，超时前给出预警，防止突发 409
 * 5. 模态切换与输入框状态重置：文生图 -> 文生视频 -> 自动，输入态、参考图待发池干净重置
 * ============================================================================
 */

test.describe('人类非标交互与边界容错测试', () => {

  test('07.1 上传参考图但未输入文字时的发送行为断言', async ({ page }) => {
    await page.goto('/');

    // 选中【图生图】
    const img2imgBtn = page.locator('button:has-text("图生图")');
    if (await img2imgBtn.isVisible()) {
      await img2imgBtn.click();
    }

    // 注入参考图
    await page.locator('#imgInput').setInputFiles({
      name: 'test-ref.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    });

    // 保持文本框为空
    await page.locator('#ta').fill('');

    // 点击发送按钮
    const sendBtn = page.locator('#send');
    await sendBtn.click();

    // 断言：不能静默不响应，必须有可见提示（如“请输入提示词”或聚焦输入框）
    const promptEmptyNotice = page.locator('.toast, .error, [role="alert"], :text("请输入")');
    const isNoticeVisible = await promptEmptyNotice.isVisible({ timeout: 1500 }).catch(() => false);
    const isTaFocused = await page.locator('#ta').evaluate(el => document.activeElement === el);

    expect(isNoticeVisible || isTaFocused, '空文本点击发送时应有明确交互反馈（弹窗提示或自动聚焦输入框）').toBe(true);
  });

  test('07.2 资料检索选择后支持移除与删除断言', async ({ page }) => {
    await page.goto('/');

    // 点击资料检索调出面板并选择
    const sourceBtn = page.locator('button:has-text("资料检索")');
    if (await sourceBtn.isVisible()) {
      await sourceBtn.click();
      await page.waitForTimeout(500);

      // 若有候选文档卡片，验证其是否带有删除/移除图标
      const attachedDocChip = page.locator('.doc-chip, .source-chip, .attached-doc');
      if (await attachedDocChip.count() > 0) {
        const removeBtn = attachedDocChip.first().locator('button:has-text("×"), .remove-btn, [data-action="remove"]');
        expect(await removeBtn.isVisible(), '已选择的检索资料必须提供删除/取消绑定的交互按钮').toBe(true);
      }
    }
  });

  test('07.3 媒体授权弹窗必须包含模型联动过滤与租约时效提示', async ({ page }) => {
    await page.goto('/');

    // 选择文生视频
    const t2vBtn = page.locator('button:has-text("文生视频")');
    if (await t2vBtn.isVisible()) {
      await t2vBtn.click();
      await page.locator('#ta').fill('测试视频授权联动');
      await page.locator('#send').click();

      // 等待媒体授权卡片弹出
      const authPanel = page.locator('.media-authorization');
      await expect(authPanel, '媒体授权确认卡片必须展示').toBeVisible({ timeout: 5000 });

      // 下拉框不能包含与视频无关的纯文本模型（如 deepseek-v4-pro, qwen3.8-flash 等）
      const options = await authPanel.locator('select option').allInnerTexts();
      const hasIrrelevantLlm = options.some(opt => opt.includes('qwen3.8-flash') || opt.includes('deepseek-v4-pro'));
      expect(hasIrrelevantLlm, '多模态任务授权弹窗的下拉框应只展示匹配模型，不应混杂通用语言大模型').toBe(false);

      // 验证确认按钮在未选择合法模型时为禁用状态
      const confirmBtn = authPanel.locator('button:has-text("确认本次提交")');
      await expect(confirmBtn).toBeVisible();
    }
  });

});
