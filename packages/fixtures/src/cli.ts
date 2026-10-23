import { startFixtures } from './index.js';

const port = Number(process.env.PORT ?? 4100);
const fixtures = await startFixtures({ port });

console.log(`测试站已启动:${fixtures.url}`);
console.log('页面:/  /courses  /contact  /dynamic  /slow  /trap  /inject  /missing');
console.log('在 UIEvidence 项目里把 127.0.0.1:' + fixtures.port + ' 加进域名白名单后即可采集。');
