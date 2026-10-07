// The HTTP server: node:http, 127.0.0.1 only. Writes need the page's token and a matching Origin,
// and every request needs a localhost Host header (which blocks DNS rebinding).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard } from './board.js';
import type { LoadedConfig } from './config.js';
import { EditError, editStatus } from './edit.js';
import { defaultRunner, GitState, type Runner } from './live.js';
import { escapeHtml, renderMarkdown, type LinkResolver } from './markdown.js';
import { readTasks, type Task } from './tasks.js';

export const DEFAULT_PORT = 4600;
export const TOKEN_HEADER = 'x-boardmd-token';

export interface ServeOptions {
  loaded: LoadedConfig;
  /** 0 picks a free port. */
  port?: number;
  offline?: boolean;
  runner?: Runner;
  /** Watch task files and git refs, and push `changed` events. On by default. */
  watch?: boolean;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const ASSET_TYPES: Record<string, string> = {
  'app.js': 'text/javascript; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
  'icon.svg': 'image/svg+xml',
};

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  const { loaded } = options;
  const offline = options.offline ?? false;
  const git = new GitState(options.runner ?? defaultRunner, loaded.tasksDir, loaded.root);
  const token = randomBytes(24).toString('base64url');
  const webDir = fileURLToPath(new URL('./web/', import.meta.url));
  const assets = new Map<string, Buffer>();
  for (const name of Object.keys(ASSET_TYPES)) assets.set(name, await readFile(join(webDir, name)));
  const pageTemplate = await readFile(join(webDir, 'index.html'), 'utf8');

  // gh takes about a second, so start fetching PRs now rather than on the first page load.
  if (loaded.config.live && !offline) void git.pullRequests();

  let port = options.port ?? DEFAULT_PORT;
  const clients = new Set<ServerResponse>();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? '';
    if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`)
      return sendText(res, 403, 'Forbidden: unexpected Host header.');
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const read = method === 'GET' || method === 'HEAD';

    if (pathname === '/') {
      if (!read) return methodNotAllowed(res, 'GET');
      const name = basename((await git.repoRoot()) ?? loaded.root);
      const page = pageTemplate
        .replaceAll('%TOKEN%', escapeHtml(token))
        .replaceAll('%TITLE%', escapeHtml(`${name} · board.md`));
      return send(res, 200, page, 'text/html; charset=utf-8', {
        'Content-Security-Policy': PAGE_CSP,
        'Referrer-Policy': 'no-referrer',
      });
    }

    if (pathname.startsWith('/assets/')) {
      const name = pathname.slice('/assets/'.length);
      const body = Object.hasOwn(ASSET_TYPES, name) ? assets.get(name) : undefined;
      if (!body) return sendJson(res, 404, { error: 'Not found.' });
      if (!read) return methodNotAllowed(res, 'GET');
      return send(res, 200, body, ASSET_TYPES[name]!);
    }

    if (pathname === '/api/board') {
      if (!read) return methodNotAllowed(res, 'GET');
      return sendJson(res, 200, await buildBoard(loaded, git, { offline }));
    }

    if (pathname === '/api/refresh') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      checkWrite(req, host, token);
      git.refresh();
      return sendJson(res, 200, await buildBoard(loaded, git, { offline, waitForPrs: true }));
    }

    if (pathname === '/api/events') {
      if (!read) return methodNotAllowed(res, 'GET');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
      });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    const taskRoute = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
    if (taskRoute) {
      let id: string;
      try {
        id = decodeURIComponent(taskRoute[1]!);
      } catch {
        return sendJson(res, 400, { error: 'Bad task id in the URL.' });
      }
      if (read) {
        const { tasks } = await readTasks(loaded);
        const task = tasks.find((t) => t.id === id);
        if (!task) return sendJson(res, 404, { error: `No task with id ${id}.` });
        const resolveLink = await linkResolver(task, tasks);
        const { body, ...rest } = task;
        return sendJson(res, 200, { ...rest, body, html: renderMarkdown(body, resolveLink) });
      }
      if (method !== 'PATCH') return methodNotAllowed(res, 'GET, PATCH');
      checkWrite(req, host, token);
      const input = await readJson(req);
      try {
        const result = await editStatus(loaded, id, input);
        return sendJson(res, 200, {
          task: withoutBody(result.task),
          changed: result.changed,
          ...(result.warning ? { warning: result.warning } : {}),
        });
      } catch (error) {
        if (error instanceof EditError)
          return sendJson(res, error.status, {
            error: error.message,
            ...(error.task ? { task: withoutBody(error.task) } : {}),
          });
        throw error;
      }
    }

    return sendJson(res, 404, { error: 'Not found.' });
  };

  /** Relative links in a task body: other task files open in the panel; repo files open on GitHub. */
  const linkResolver = async (task: Task, tasks: Task[]): Promise<LinkResolver> => {
    const [top, repoUrl] = await Promise.all([git.repoRoot(), git.repoUrl()]);
    const byPath = new Map(tasks.map((t) => [t.absPath, t]));
    return (href, kind) => {
      const [pathPart = '', fragment] = href.split('#', 2);
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathPart.split('?')[0]!);
      } catch {
        return null;
      }
      const target = decoded.startsWith('/')
        ? join(top ?? loaded.root, decoded)
        : resolve(dirname(task.absPath), decoded);
      const linked = byPath.get(target);
      if (linked && kind === 'link') return `?task=${encodeURIComponent(linked.id)}`;
      if (!repoUrl || !top) return null;
      const rel = relative(top, target);
      if (rel.startsWith('..') || isAbsolute(rel)) return null;
      const path = rel.split(sep).map(encodeURIComponent).join('/');
      return `${repoUrl}/${kind === 'image' ? 'raw' : 'blob'}/HEAD/${path}${fragment ? `#${fragment}` : ''}`;
    };
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      console.error(error);
      if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message ?? 'Internal error.' });
      else res.end();
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  port = (server.address() as AddressInfo).port;

  const broadcast = (event: string, data: unknown) => {
    for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25_000);
  heartbeat.unref();

  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  const changed = (reason: 'files' | 'git' | 'prs') => {
    clearTimeout(timer);
    timer = setTimeout(() => broadcast('changed', { reason }), 150);
  };
  git.onPullRequestsChanged = () => changed('prs');
  const tryWatch = (path: string, recursive: boolean, onChange: (file: string | null) => void) => {
    try {
      const w = watch(path, { recursive }, (_event, file) => onChange(file === null ? null : String(file)));
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      // Not every platform can watch every folder; the page still has its Refresh button.
    }
  };
  if (options.watch ?? true) {
    tryWatch(loaded.tasksDir, true, (file) => {
      if (file === null || file.endsWith('.md')) changed('files');
    });
    const dirs = await git.gitDirs();
    if (dirs) {
      tryWatch(dirs.gitDir, false, (file) => {
        if (file === 'HEAD') changed('git');
      });
      tryWatch(join(dirs.commonDir, 'refs', 'heads'), true, () => changed('git'));
    }
  }

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    close: async () => {
      clearInterval(heartbeat);
      clearTimeout(timer);
      for (const w of watchers) w.close();
      for (const res of clients) res.end();
      clients.clear();
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    },
  };
}

/** Writes need the page's token and an Origin header that matches the Host. */
function checkWrite(req: IncomingMessage, host: string, token: string): void {
  if (req.headers.origin !== `http://${host}`)
    throw new HttpError(403, 'Forbidden: missing or wrong Origin header.');
  const given = req.headers[TOKEN_HEADER];
  if (typeof given !== 'string' || !safeEqual(given, token))
    throw new HttpError(403, 'Forbidden: missing or wrong write token.');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? ''))
    throw new HttpError(415, 'Send JSON (Content-Type: application/json).');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

function withoutBody(task: Task): Omit<Task, 'body'> {
  const { body: _body, ...rest } = task;
  return rest;
}

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  type: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

function sendText(res: ServerResponse, status: number, text: string): void {
  send(res, status, `${text}\n`, 'text/plain; charset=utf-8');
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: `Method not allowed. Use ${allow}.` });
}
