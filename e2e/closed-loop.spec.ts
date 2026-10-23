import { expect, test } from '@playwright/test';

const SITE = 'http://127.0.0.1:4391';

test('MVP 闭环:新建项目 → 添加页面 → 采集 → 整理功能 → 导出', async ({ page }) => {
  await page.goto('/');

  // 新建项目:必须勾选授权确认才能提交
  await page.getByRole('button', { name: '新建项目' }).click();
  await page.getByPlaceholder('例如:某培训机构官网').fill('端到端测试项目');
  await page.locator('textarea[placeholder^="每行一个"]').fill('127.0.0.1:4391');
  await page.getByPlaceholder('说明你为什么有权分析这个网站').fill('自建测试站');
  const submit = page.getByRole('button', { name: '创建项目' });
  await expect(submit).toBeDisabled();
  await page.getByLabel('我确认只分析公开网站').check();
  await submit.click();
  await expect(page.getByRole('heading', { name: '端到端测试项目' })).toBeVisible();

  // 白名单外的网址不能加入,白名单内的可以
  const urls = page.getByPlaceholder('https://example.com/courses');
  await urls.fill(`http://localhost:4391/\n${SITE}/courses\n${SITE}/trap`);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByText('该网址不在白名单内')).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(2);

  // 采集全部,等两个页面都变成"成功"
  await page.getByRole('button', { name: '采集全部' }).click();
  await expect(page.locator('tbody tr .badge', { hasText: '成功' })).toHaveCount(2, { timeout: 60_000 });

  // 陷阱页上的危险按钮只记录、不执行,出现在分析缺口里
  await page.getByRole('tab', { name: /分析缺口/ }).click();
  await expect(page.getByText('「删除全部数据」未执行')).toBeVisible();
  await expect(page.getByText('触发了 1 个写入类请求')).toBeVisible();

  // 打开课程页的证据,从候选创建功能条目
  await page.getByRole('tab', { name: '页面与证据' }).click();
  await page.locator('tbody tr', { hasText: '/courses' }).getByRole('button', { name: '查看' }).click();
  await expect(page.getByText('E-001')).toBeVisible();
  await page.getByRole('button', { name: /创建 \d+ 条功能条目/ }).click();
  await page.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('tab', { name: '功能整理' }).click();
  await expect(page.getByText('内容列表')).toBeVisible();

  // 补充一条后台需求
  await page.getByRole('tab', { name: '需求与待确认' }).click();
  await page.getByRole('button', { name: '新建条目' }).click();
  await page.locator('.modal input[type="text"]').first().fill('管理员按角色分配权限');
  await page.locator('.modal select').first().selectOption('requirement');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('管理员按角色分配权限')).toBeVisible();

  // 导出
  await page.getByRole('tab', { name: '导出' }).click();
  await page.getByRole('button', { name: '生成报告' }).click();
  const html = page.getByRole('link', { name: '打开 HTML 报告' });
  await expect(html).toBeVisible();
  const href = await html.getAttribute('href');

  const report = await page.request.get(href as string);
  expect(report.ok()).toBe(true);
  const text = await report.text();
  expect(text).toContain('管理员按角色分配权限');
  expect(text).toContain(`${SITE}/courses`);
});
