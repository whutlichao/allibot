import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 同源静态宿主 (M4 / D1–D6)：`serve` 自己托管构建产物。
 *
 * 静态根由模块位置解析（本文件在 `server/src` 与其构建产物在 `server/dist`
 * 都相对仓库根只隔一层），不用 `process.cwd()` —— 从别处启动的进程若按工作
 * 目录找，会静默变成「打开全是 404」。
 */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../web/dist', import.meta.url));

/** Vite 产物在 `/assets/` 下且带内容 hash；它最容易被误认为前端路由，所以失败必须硬 404。 */
const ASSETS_PREFIX = '/assets/';

/** Vite 产物带内容 hash，一年不可变；其余靠重新验证。 */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE = 'no-cache';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * 一个请求是否归静态宿主 (D1)：`GET` / `HEAD`，且不在 `/api` 前缀下。
 *
 * `/api` 的未命中必须继续落既有的 JSON `not_found` 信封；若它被 SPA 回退吞成
 * HTML，前端的 `response.json()` 就会在拼错路径时抛错而不是读到错误码。
 */
export function isStaticRequest(method: string | undefined, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') {
    return false;
  }
  return !pathname.startsWith('/api');
}

export async function serveStaticRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  webRoot: string,
): Promise<void> {
  const root = path.resolve(webRoot);
  const target = resolveRequestTarget(root, pathname);
  if (target === null) {
    sendNotFound(response, pathname);
    return;
  }
  const requestedBody = await readFileIfPresent(target.filePath);
  if (requestedBody !== null) {
    sendFile(request, response, root, target.filePath, requestedBody);
    return;
  }
  // 判定表的后三条（D2）：`/assets/` 的缺失与带点的最后一段都是硬 404，只有
  // 看起来像前端路由的路径才回到页壳。否则一个写错的样式表会静默变成 HTML，
  // 而浏览器只报「样式不生效」。
  if (target.path.startsWith(ASSETS_PREFIX) || lastPathSegment(target.path).includes('.')) {
    sendNotFound(response, pathname);
    return;
  }
  const indexPath = path.join(root, 'index.html');
  const indexBody = await readFileIfPresent(indexPath);
  if (indexBody === null) {
    sendNotFound(response, pathname);
    return;
  }
  sendFile(request, response, root, indexPath, indexBody);
}

/** 最后一段带点就是资源路径而不是前端路由（`/channels/abc` 不带点）。 */
function lastPathSegment(requestPath: string): string {
  const segments = requestPath.split('/');
  return segments[segments.length - 1] ?? '';
}

interface RequestTarget {
  /** 归一后的 URL 路径：判定表看它的前缀与最后一段。 */
  path: string;
  /** 该路径在静态根下的磁盘候选位置。 */
  filePath: string;
}

/**
 * 请求路径 → 静态根内的候选文件（D4）。两道屏障各自都不够：`%2e%2e%2f` 这种
 * 编码斜线在 URL 解析那一层不算段分隔符，解码后才变成 `..`；而看着干净的已
 * 编码路径也可能在拼接后跑出静态根。拒绝就是 `null`，调用方回 404。
 */
function resolveRequestTarget(root: string, pathname: string): RequestTarget | null {
  const decoded = decodePathname(pathname);
  if (decoded === null || decoded.split('/').includes('..')) {
    return null;
  }
  const normalized = path.posix.normalize(decoded);
  const filePath = path.join(root, normalized);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    return null;
  }
  return { path: normalized, filePath };
}

/** 百分号编码坏了就是「没有这个文件」，不是 500。 */
function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/** 目录、不存在的文件与带 NUL 的非法路径都读不到字节，对调用方是同一件事（404）。 */
async function readFileIfPresent(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === 'ENOENT' ||
      code === 'EISDIR' ||
      code === 'ENOTDIR' ||
      code === 'ERR_INVALID_ARG_VALUE'
    ) {
      return null;
    }
    throw error;
  }
}

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  filePath: string,
  body: Buffer,
): void {
  response.writeHead(200, {
    'content-type': contentTypeFor(filePath),
    'content-length': body.length,
    'cache-control': cacheControlFor(root, filePath),
    'x-content-type-options': 'nosniff',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function cacheControlFor(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  return relative.startsWith(`assets${path.sep}`) ? IMMUTABLE_CACHE : REVALIDATE_CACHE;
}

function sendNotFound(response: ServerResponse, pathname: string): void {
  const payload = `not found: ${pathname}\n`;
  response.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': REVALIDATE_CACHE,
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}
