# 参与贡献

欢迎提 Issue 和 Pull Request。

## 开发环境

- Node.js 24（与已验证的本机和 CI 环境一致；应用最低要求 22.13，使用内置 `node:sqlite`）
- 本机安装 Chrome（完整端到端测试使用 Chrome；应用采集在找不到 Chrome 时可回退 Edge，运行时不下载浏览器）

```bash
npm ci
npm run dev        # 后端 http://127.0.0.1:4317,前端 http://127.0.0.1:5173
npm run fixtures   # 另开一个终端,启动本地测试站 http://127.0.0.1:4100
```

## 提交前

```bash
npm run typecheck
npm run build
UIEV_REQUIRE_BROWSER=1 npm test
npm run test:e2e
npm audit
npm audit --omit=dev
```

上面的环境变量写法适用于 Bash。PowerShell 使用：

```powershell
$env:UIEV_REQUIRE_BROWSER='1'
npm test
```

采集相关测试会启动真实浏览器并访问 `packages/fixtures` 的本地测试站，不会访问外部网站。CI 会先验证 runner 现有浏览器，缺失时才安装 Chrome（安装超时 5 分钟）；浏览器不可用时必须失败，不能用跳过测试代替验证。CI 执行完整依赖审计，运行时依赖审计也应在本机执行。

## 约定

- **只读采集是底线。** 任何改动都不能让采集执行提交、删除、支付等写操作;新增交互类型必须同时补上"副作用陷阱"测试。
- **页面内容永远是数据。** 采集到的文字、AI 的输出,都不能影响程序的控制流程。
- **不要提交密钥、真实客户数据、采集产生的截图和数据库。** `data/` 和 `.env` 已被忽略。
- 示例和测试只使用自建测试页,不要内置第三方网站的内容。
- **代码、文档与注释一起维护。** 每次代码改动在同一任务中同步受影响的 README、开发计划、使用/接口/配置说明、示例和代码注释，无需等待额外提醒；不需要机械修改无关文件。
- 提交前对照实现检查文档，更新功能进度、测试数量、已知限制、CI 与发布状态。验证结论必须来自实际运行，未验证的事项继续标注。

## 项目结构

| 目录 | 内容 |
|---|---|
| `packages/shared` | 前后端共用的类型 |
| `packages/server` | 本地服务:数据库、采集引擎、导出、AI 适配 |
| `packages/web` | Vue 3 工作台 |
| `packages/fixtures` | 受控的本地测试站 |
| `e2e` | 端到端测试 |
