import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

// Минимальный валидный PNG 1×1.
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export async function startTestApp({ recognizer, readPage, env = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-test-'));
  const config = loadConfig({ DATA_DIR: dataDir, ALLOW_PRIVATE_FETCH: '1', ...env });
  const db = openDb(':memory:');
  const rec =
    recognizer ||
    Object.assign(async () => ({ fields: {}, review: {}, items: [], requirementsVisible: false }), { configured: true });
  const app = createApp({ db, config, recognizer: rec, ...(readPage ? { readPage } : {}) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, url, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    return { status: res.status, json, text, headers: res.headers };
  }
  const api = {
    get: (u) => request('GET', u),
    post: (u, b) => request('POST', u, b ?? {}),
    patch: (u, b) => request('PATCH', u, b),
    delete: (u) => request('DELETE', u),
    raw: request,
  };

  return {
    base,
    db,
    config,
    api,
    close: () => new Promise((resolve) => server.close(resolve)).then(() => fs.rmSync(dataDir, { recursive: true, force: true })),
  };
}

export function formWith({ url, files = 0, mode } = {}) {
  const fd = new FormData();
  if (url !== undefined) fd.append('url', url);
  if (mode) fd.append('mode', mode);
  for (let i = 0; i < files; i += 1) fd.append('files', new Blob([PNG], { type: 'image/png' }), `скрин-${i + 1}.png`);
  return fd;
}

/** Кодировка windows-1251 для проверки страниц в старых кодировках. */
export function encode1251(str) {
  const bytes = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c >= 0x410 && c <= 0x44f) bytes.push(c - 0x410 + 0xc0);
    else if (c === 0x401) bytes.push(0xa8);
    else if (c === 0x451) bytes.push(0xb8);
    else if (c === 0x2116) bytes.push(0xb9);
    else bytes.push(0x3f);
  }
  return Buffer.from(bytes);
}

/** Локальный сайт-«площадка» для проверки чтения ссылок. */
export async function startFakeSite() {
  const requirementsPage = `<!doctype html><html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1251"><title>Закупка 123</title></head><body>
    <script>var secret = 'не должно попасть в текст';</script>
    <h1>Поставка датчиков вибрации</h1>
    <table><tr><td>Заказчик</td><td>ООО «Компания А»</td></tr>
    <tr><td>Номер закупки</td><td>№ 0123-45</td></tr>
    <tr><td>Окончание подачи заявок</td><td>15.12.2026 17:00 МСК</td></tr></table>
    <p>К заявке необходимо приложить ценовое предложение и паспорт оборудования. Дополнительные документы предоставляются по желанию участника закупки. Подробности и условия участия указаны в закупочной документации, размещённой на площадке.</p>
  </body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(encode1251(requirementsPage));
    } else if (req.url === '/forbidden') {
      res.writeHead(403).end('forbidden');
    } else if (req.url === '/wall') {
      res.writeHead(302, { location: '/login?next=/wall' }).end();
    } else if (req.url.startsWith('/login')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><form><input name="u"><input type="password" name="p"></form></body></html>');
    } else if (req.url === '/spa') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><div id="root"></div><script>render()</script></body></html>');
    } else {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}
