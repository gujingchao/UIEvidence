import { expect, test, type Page } from '@playwright/test';
import { startFixtures, type FixtureServer } from '@uievidence/fixtures';

/** 等页面清单里的每一行都有了最终状态(而不是等"没有进行中的",那样会在状态出现之前就误判为已结束) */
async function waitAllCaptured(page: Page, rows: number): Promise<void> {
  await expect(page.locator('tbody tr')).toHaveCount(rows, { timeout: 30_000 });
  await expect(page.locator('tbody tr .badge', { hasText: /^(成功|部分成功|失败|需要登录)$/ })).toHaveCount(rows, { timeout: 120_000 });
}

test.describe('示例项目:从一个入口页走完整个流程,全程不输入网址', () => {
  test('采集 → 发现页面 → 一键加入 → 证据与功能互相跳转 → 导出', async ({ page }) => {
    await page.goto('/');

    // 第一次使用:有引导,一键创建示例项目
    await expect(page.getByRole('heading', { name: '开始分析一个网站' })).toBeVisible();
    await page.getByRole('button', { name: '先用示例项目体验一遍' }).click();
    await expect(page.getByRole('heading', { name: '示例:培训机构网站' })).toBeVisible();

    // 概览:流程看板,第 2 步高亮并带主按钮
    await expect(page.locator('.flow li.next')).toContainText('采集页面,保存证据');
    await page.getByRole('button', { name: '采集 1 个新页面' }).click();
    await expect(page.locator('.flow li.done', { hasText: '采集页面,保存证据' })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.flow li.next')).toContainText('整理页面功能');

    // 采集完发现了新页面,待办里有入口;跟着走,不用输入任何网址
    await expect(page.locator('.todo')).toContainText('还没加入的页面');
    await page.getByRole('link', { name: '去加入' }).click();
    await expect(page).toHaveURL(/#\/projects\/1\/pages$/);
    await expect(page.getByRole('heading', { name: /发现了 \d+ 个新页面/ })).toBeVisible();
    // 退出登录这类会改变状态的链接不在其中,并说明了原因
    await expect(page.locator('.discovered')).not.toContainText('退出登录');
    await page.getByRole('button', { name: '加入并采集' }).click();
    await waitAllCaptured(page, 8); // 入口页 + 发现的 7 个页面

    // 受保护的会员页被识别为"需要登录",并指引去登录
    await expect(page.locator('tbody tr', { hasText: '/members' }).locator('.badge')).toHaveText('需要登录');
    await expect(page.locator('.notice')).toContainText('被挡在登录页外');
    await expect(page.getByRole('link', { name: '去登录' }).first()).toBeVisible();

    // 证据抽屉的状态在地址里:刷新后仍然在原处,上一个/下一个页面可切换
    await page.locator('tbody tr', { hasText: '/courses' }).first().getByRole('button', { name: '查看证据' }).click();
    await expect(page).toHaveURL(/\?page=\d+/);
    await expect(page.locator('.drawer h2')).toContainText('课程列表');
    await page.reload();
    await expect(page.locator('.drawer h2')).toContainText('课程列表');
    await page.getByRole('button', { name: '下一个页面' }).click();
    await expect(page.locator('.drawer h2')).not.toContainText('课程列表');
    await page.getByRole('button', { name: '上一个页面' }).click();
    await expect(page.locator('.drawer h2')).toContainText('课程列表');

    // 在抽屉里创建功能条目,提示条带一个直达的按钮
    await page.getByRole('button', { name: /创建 \d+ 条功能条目/ }).click();
    await page.getByRole('link', { name: /去功能整理查看/ }).click();
    await expect(page).toHaveURL(/#\/projects\/1\/features/);
    await expect(page.getByText('内容列表')).toBeVisible();

    // 条目上的证据编号可以点回对应的证据
    await page.locator('.feature button.chip.evidence').first().click();
    await expect(page).toHaveURL(/page=\d+&capture=\d+/);
    await expect(page.locator('.drawer img.shot')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.drawer')).toHaveCount(0);

    // 分析缺口:危险按钮只记录没执行,每条能跳到对应页面
    await page.getByRole('tab', { name: /分析缺口/ }).click();
    await expect(page.getByText('「删除全部数据」未执行')).toBeVisible();
    await expect(page.getByText(/POST \/api\/track/)).toBeVisible();

    // 补充需求
    await page.getByRole('tab', { name: '需求与待确认' }).click();
    await page.getByRole('button', { name: '新建条目' }).first().click();
    await page.locator('.modal input[type="text"]').first().fill('管理员按角色分配权限');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('管理员按角色分配权限')).toBeVisible();

    // 导出:在工作台里直接预览,报告本身没有工作台的链接
    await page.getByRole('tab', { name: '导出' }).click();
    await page.getByRole('button', { name: '生成报告' }).click();
    const frame = page.frameLocator('iframe.report-preview');
    await expect(frame.getByRole('heading', { name: /网站功能分析报告/ })).toBeVisible({ timeout: 15_000 });
    await expect(frame.getByText('管理员按角色分配权限')).toBeVisible();
    await expect(frame.locator('a[href^="#/"]')).toHaveCount(0);
  });
});

test.describe('手动建项目', () => {
  let fx: FixtureServer;
  test.beforeAll(async () => {
    fx = await startFixtures();
  });
  test.afterAll(async () => {
    await fx.close();
  });

  test('必须确认授权才能创建;白名单外的网址加不进去', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '新建项目' }).first().click();
    await page.getByPlaceholder('例如:某培训机构官网').fill('手动项目');
    await page.locator('textarea[placeholder^="每行一个"]').fill(`127.0.0.1:${fx.port}`);
    await page.getByPlaceholder('说明你为什么有权分析这个网站').fill('自建测试站');
    const submit = page.getByRole('button', { name: '创建项目' });
    await expect(submit).toBeDisabled();
    await page.getByLabel('我确认只分析公开网站').check();
    await submit.click();
    await expect(page.getByRole('heading', { name: '手动项目' })).toBeVisible();

    // 没有页面时,概览指向"添加页面"
    await expect(page.locator('.flow li.next')).toContainText('添加要分析的页面');
    await page.getByRole('tab', { name: '页面与证据' }).click();
    await page.getByPlaceholder('https://example.com/').fill(`${fx.aliasUrl}/\n${fx.url}/trap`);
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await expect(page.getByText('不在白名单内')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(1);

    // 陷阱页:采集后危险按钮没有被点击
    await page.locator('tbody tr').getByRole('button', { name: '采集', exact: true }).click();
    await expect(page.locator('tbody tr .badge')).toHaveText('成功', { timeout: 60_000 });
    // 页面确实被打开过(测试站收到了 GET),但没有收到任何写入请求
    expect(fx.log().some((e) => e.path === '/trap' && e.method === 'GET')).toBe(true);
    expect(fx.writes()).toEqual([]);
  });
});
