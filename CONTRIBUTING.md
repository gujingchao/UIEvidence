# 参与贡献

欢迎提 Issue 和 Pull Request。

## 开发环境

- Node.js 22.13 或更高(使用内置的 `node:sqlite`,不需要编译原生模块)
- 本机安装 Chrome 或 Edge(采集用,不会下载浏览器)

```bash
npm install
npm run dev        # 后端 http://127.0.0.1:4317,前端 http://127.0.0.1:5173
npm run fixtures   # 另开一个终端,启动本地测试站 http://127.0.0.1:4100
```

## 提交前

```bash
npm run typecheck
npm test
```

采集相关的测试会启动真实浏览器并访问 `packages/fixtures` 里的本地测试站,不会访问任何外部网站。

## 约定

- **只读采集是底线。** 任何改动都不能让采集执行提交、删除、支付等写操作;新增交互类型必须同时补上"副作用陷阱"测试。
- **页面内容永远是数据。** 采集到的文字、AI 的输出,都不能影响程序的控制流程。
- **不要提交密钥、真实客户数据、采集产生的截图和数据库。** `data/` 和 `.env` 已被忽略。
- 示例和测试只使用自建测试页,不要内置第三方网站的内容。

## 项目结构

| 目录 | 内容 |
|---|---|
| `packages/shared` | 前后端共用的类型 |
| `packages/server` | 本地服务:数据库、采集引擎、导出、AI 适配 |
| `packages/web` | Vue 3 工作台 |
| `packages/fixtures` | 受控的本地测试站 |
| `e2e` | 端到端测试 |
