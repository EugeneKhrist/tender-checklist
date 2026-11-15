import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import * as cheerio from 'cheerio';

const MAX_BYTES = 6 * 1024 * 1024;
const MAX_TEXT_CHARS = 60_000;
const MAX_REDIRECTS = 5;
const TOTAL_TIMEOUT_MS = 25_000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ---------- защита от SSRF: сервер не должен ходить во внутреннюю сеть ---------- */

export function isPrivateIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    const first = parseInt(s.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true;
}

function guardedLookup(allowPrivate) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const ok = allowPrivate ? addrs : addrs.filter((a) => !isPrivateIp(a.address));
      if (!ok.length) return cb(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
      if (options.all) return cb(null, ok);
      cb(null, ok[0].address, ok[0].family);
    });
  };
}

/* ---------- HTTP-запрос с ручными редиректами и ограничением размера ---------- */

function requestOnce(urlObj, { allowPrivate }) {
  return new Promise((resolve, reject) => {
    const host = urlObj.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && isPrivateIp(host)) {
      return reject(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    }
    const lib = urlObj.protocol === 'https:' ? https : http;
    const req = lib.request(
      urlObj,
      {
        method: 'GET',
        lookup: guardedLookup(allowPrivate),
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5',
          'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          return resolve({ status, redirect: res.headers.location, headers: res.headers });
        }
        let stream = res;
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        const chunks = [];
        let size = 0;
        let done = false;
        const finish = (truncated) => {
          if (done) return;
          done = true;
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated });
          if (truncated) req.destroy();
        };
        stream.on('data', (c) => {
          size += c.length;
          chunks.push(c);
          if (size > MAX_BYTES) finish(true);
        });
        stream.on('end', () => finish(false));
        stream.on('error', (e) => {
          if (!done) {
            done = true;
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function download(startUrl, { allowPrivate }) {
  let current = new URL(startUrl);
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const left = deadline - Date.now();
    if (left <= 0) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    let timer;
    const result = await Promise.race([
      requestOnce(current, { allowPrivate }),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), left);
      }),
    ]).finally(() => clearTimeout(timer));
    if (result.redirect) {
      const next = new URL(result.redirect, current);
      if (!['http:', 'https:'].includes(next.protocol)) throw new Error('bad redirect');
      current = next;
      continue;
    }
    return { ...result, finalUrl: current.toString() };
  }
  throw Object.assign(new Error('too many redirects'), { code: 'EREDIRECTS' });
}

/* ---------- разбор HTML ---------- */

function decodeBody(buf, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

export function extractText(html) {
  const $ = cheerio.load(html);
  const title = ($('meta[property="og:title"]').attr('content') || $('title').first().text() || '').trim();
  const hasPasswordInput = $('input[type="password"]').length > 0;
  $('script,style,noscript,svg,iframe,template,head,select option').remove();
  $('br').replaceWith('\n');
  $('p,div,li,tr,h1,h2,h3,h4,h5,h6,section,article,header,footer,ul,ol,table,dl,dt,dd,form,fieldset').each(
    (_, el) => {
      $(el).append('\n');
    },
  );
  $('td,th').each((_, el) => {
    $(el).append(' | ');
  });
  let text = $('body').length ? $('body').text() : $.root().text();
  text = text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').replace(/(\s\|)+\s*$/, '').trim())
    .filter(Boolean)
    .join('\n');
  if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n[…текст обрезан…]`;
  return { title, text, hasPasswordInput };
}

const LOGIN_URL_RE = /(^|[/._-])(login|signin|sign-in|logon|auth|sso|oauth|cas|account\/login)([/._?-]|$)/i;

/**
 * Читает страницу закупки.
 * status: 'ok' | 'login_required' | 'unreachable' | 'empty' | 'invalid'
 */
export async function readTenderPage(url, { allowPrivate = false } = {}) {
  let res;
  try {
    res = await download(url, { allowPrivate });
  } catch (err) {
    const code = err.code || '';
    let message = 'Не удалось открыть страницу по ссылке.';
    if (code === 'EBLOCKED') message = 'Адрес ссылки недоступен для автоматической проверки.';
    else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') message = 'Сайт по ссылке не найден.';
    else if (code === 'ETIMEDOUT' || code === 'ECONNRESET') message = 'Сайт не ответил вовремя.';
    else if (code === 'ECONNREFUSED') message = 'Сайт отказал в соединении.';
    else if (code === 'EREDIRECTS') message = 'Слишком много перенаправлений при открытии ссылки.';
    else if (String(code).startsWith('CERT') || String(code).includes('SELF_SIGNED'))
      message = 'У сайта проблема с сертификатом безопасности.';
    return { status: 'unreachable', message, text: '', title: '' };
  }

  const { status, headers, finalUrl } = res;
  if (status === 401 || status === 403) {
    return {
      status: 'login_required',
      message: 'Страница требует входа в аккаунт или закрыта для автоматического доступа.',
      text: '',
      title: '',
      finalUrl,
    };
  }
  if (status >= 400) {
    return {
      status: 'unreachable',
      message: status === 404 || status === 410 ? 'Страница не найдена (ошибка 404).' : `Сайт ответил ошибкой ${status}.`,
      text: '',
      title: '',
      finalUrl,
    };
  }

  const contentType = String(headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/pdf')) {
    if (res.truncated || res.body.length > 20 * 1024 * 1024) {
      return { status: 'unreachable', message: 'PDF-файл по ссылке слишком большой.', text: '', title: '', finalUrl };
    }
    return { status: 'ok', message: '', text: '', title: '', finalUrl, pdf: res.body };
  }
  if (contentType && !/(text\/|xml|json)/.test(contentType)) {
    return {
      status: 'unreachable',
      message: 'Ссылка ведёт на файл неподдерживаемого типа.',
      text: '',
      title: '',
      finalUrl,
    };
  }

  const html = decodeBody(res.body, contentType);
  const { title, text, hasPasswordInput } = extractText(html);

  const redirectedToLogin = finalUrl !== new URL(url).toString() && LOGIN_URL_RE.test(new URL(finalUrl).pathname);
  if (redirectedToLogin || (hasPasswordInput && text.length < 2000)) {
    return {
      status: 'login_required',
      message: 'Страница требует входа в аккаунт.',
      text: '',
      title,
      finalUrl,
    };
  }
  if (text.length < 200) {
    return {
      status: 'empty',
      message: 'Страница открылась, но текста на ней почти нет (возможно, содержимое подгружается скриптами).',
      text: '',
      title,
      finalUrl,
    };
  }
  return { status: 'ok', message: '', text, title, finalUrl };
}
