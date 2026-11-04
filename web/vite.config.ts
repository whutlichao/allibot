import react from '@vitejs/plugin-react';
import process from 'node:process';
import { defineConfig } from 'vite';

/**
 * 后端 origin 的默认值：`serve` 绑定 `127.0.0.1:3000`（见 `docs/deployment.md`
 * 的「本地开发」）。写完整 origin 而不是只写端口，是因为代理目标是 URL。
 */
const DEFAULT_API_ORIGIN = 'http://127.0.0.1:3000';

/**
 * `/api` 代理的目标 origin。
 *
 * 进程级变量 `allibot_API_ORIGIN` 覆盖默认值，命名与既有的
 * `allibot_DATA_DIR` / `allibot_HOME_DIR` / `allibot_DOCKER_IMAGE` 一致。空值
 * 按未设置处理：把空字符串当 origin 会让代理在启动时才以更难读的方式失败。
 */
export function apiOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.allibot_API_ORIGIN?.trim() ?? '';
  return configured.length > 0 ? configured : DEFAULT_API_ORIGIN;
}

/** 代理转发的路径前缀：后端路由本身就是 `/api/...`，所以路径原样转发。 */
const API_PREFIX = '/api';

export default defineConfig({
  plugins: [react()],
  server: {
    /**
     * 一条规则覆盖 `/api` 下全部三面：
     *
     * - REST 读数（`/api/workspace`、`/api/settings` 等）；
     * - SSE 长连接（`/api/events`）：代理按响应体流式转发、不缓冲，所以帧
     *   到达前端时不会被攒住，连接也不会立刻被结束；
     * - CopilotKit handler（`/api/copilotkit`）：它自己再分流多个子路由并读
     *   请求体流，前缀转发让这些子路由后面端自决，前端不重复实现路由表。
     *
     * 三面共用一个前缀而不是各写一条规则，因为后端对它们的路径判定是同一个
     * 前缀；分三条规则只会在某一面漏掉时把 SPA fallback 的 `text/html` 当成
     * 后端响应。
     *
     * 不做路径改写（`rewrite`）：后端路由带 `/api` 前缀，改写会让三面同时 404。
     * 也不改 `changeOrigin`：后端不按 Host / Origin 判定来源，代理保持请求原样。
     */
    proxy: {
      [API_PREFIX]: {
        target: apiOrigin(),
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
