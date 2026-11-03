import http from 'node:http';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.DEPLOY_PREVIEW_PORT || 4186);
http
  .createServer(async (req, res) => {
    const routes = {
      '/': ['index.html', 'text/html'],
      '/index.html': ['index.html', 'text/html'],
      '/app.js': ['app.js', 'text/javascript'],
      '/app.css': ['app.css', 'text/css'],
      '/app.js.map': ['app.js.map', 'application/json'],
    };
    const route = routes[new URL(req.url, 'http://localhost').pathname];
    if (!route) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    try {
      const content = await fs.readFile(path.join(root, route[0]));
      res.writeHead(200, {
        'Content-Type': route[1] + ';charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(content);
    } catch {
      res.writeHead(503);
      res.end('Run npm run build first');
    }
  })
  .listen(port, '127.0.0.1', () =>
    console.log(`Deploy Center prototype: http://127.0.0.1:${port}`),
  );
