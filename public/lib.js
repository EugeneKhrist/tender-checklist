// Небольшие помощники: создание элементов без innerHTML, запросы, даты, сжатие фото.

/** h('div', {class:'x', onclick: fn}, 'текст', childEl) — весь текст вставляется как текст, не как HTML. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple' || k === 'open') el[k] = !!v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  if (value !== undefined) el.value = value;
  return el;
}

/** replaceChildren, который пропускает null/false (иначе в страницу попадёт текст «null»). */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError(0, 'Нет связи с сервером. Проверьте интернет и повторите.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error || 'Ошибка запроса');
  return data;
}

export function toast(text, kind = 'ok') {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind === 'error' ? 'error' : ''}`, role: 'status', text });
  box.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 2800);
}

/** Разрешаем в ссылках только http(s). */
export function safeUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.toString() : null;
  } catch {
    return null;
  }
}

export function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
}

/** «15.12.2026 17:00 МСК», либо то, что удалось прочитать. */
export function fmtDeadline(t) {
  const parts = [];
  if (t.deadline_date) parts.push(fmtDate(t.deadline_date));
  if (t.deadline_time) parts.push(t.deadline_time);
  if (parts.length && t.deadline_tz) parts.push(t.deadline_tz);
  if (parts.length) return parts.join(' ');
  return t.deadline_raw || '';
}

export function isExpired(t) {
  if (!t.deadline_date) return false;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return t.deadline_date < today;
}

const MAX_SIDE = 2200;
const MAX_BYTES = 5 * 1024 * 1024;

/** Уменьшает большие фото/скриншоты до разумного размера перед отправкой. */
export async function prepareImage(file) {
  if (!file.type.startsWith('image/')) throw new Error(`«${file.name}» — не изображение`);
  const small = file.size <= 1.5 * 1024 * 1024;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    if (file.size > MAX_BYTES) throw new Error(`«${file.name}» слишком большой — уменьшите изображение`);
    return file;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (small && scale === 1) {
    bitmap.close?.();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.88));
  if (!blob || blob.size >= file.size) {
    if (file.size > MAX_BYTES) throw new Error(`«${file.name}» слишком большой — уменьшите изображение`);
    return file;
  }
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], name, { type: 'image/jpeg' });
}
