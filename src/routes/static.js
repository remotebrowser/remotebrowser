import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';

const PUBLIC_DIR = new URL('../../public/', import.meta.url);

const serveFile =
  (path, contentType = 'text/plain') =>
  async (c) => {
    // new URL resolves dot segments, so any path escaping PUBLIC_DIR is caught here.
    const url = new URL(path, PUBLIC_DIR);
    if (!url.pathname.startsWith(PUBLIC_DIR.pathname)) {
      return c.text('Not Found', 404);
    }
    const file = await readFile(url);
    // A charset only makes sense for text; the icon and font are binary.
    const charset = contentType === 'image/x-icon' || contentType === 'font/woff2' ? '' : '; charset=utf-8';
    c.header('Content-Type', `${contentType}${charset}`);
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(file);
  };

export const routes = new Hono();

routes.get('/style.css', serveFile('style.css', 'text/css'));
routes.get('/fonts/figtree-variable.woff2', serveFile('fonts/figtree-variable.woff2', 'font/woff2'));
routes.get('/robots.txt', serveFile('robots.txt'));
routes.get('/favicon.ico', serveFile('favicon.ico', 'image/x-icon'));
routes.get('/tagline.js', serveFile('tagline.js', 'text/javascript'));
routes.get('/theme.js', serveFile('theme.js', 'text/javascript'));
routes.get('/screencast.js', serveFile('screencast.js', 'text/javascript'));
routes.get('/htmx.min.js', serveFile('htmx.min.js', 'text/javascript'));
routes.get('/terms', serveFile('terms.html', 'text/html'));
routes.get('/privacy-policy', serveFile('privacy-policy.html', 'text/html'));
