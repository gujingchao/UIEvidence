import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

// 可选的 .env,只用来放模型服务的密钥;已加入 .gitignore
const envFile = path.join(repoRoot, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.PORT ?? 4317);
const dataDir = path.resolve(process.env.UIEV_DATA_DIR ?? path.join(repoRoot, 'data'));
const webDist = path.join(repoRoot, 'packages/web/dist');

const { app } = await createApp({ dataDir, webDist, port });
// 只监听本机地址:这是本地工具,不对局域网开放
await app.listen({ port, host: '127.0.0.1' });

console.log(`UIEvidence 已启动:http://127.0.0.1:${port}`);
console.log(`数据目录:${dataDir}`);
