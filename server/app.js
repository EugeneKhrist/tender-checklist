import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { transaction } from './db.js';
import { ITEM_SQL, REVIEW_KEYS, findTender, listTenders, serializeItem, serializeTender, touchTender } from './store.js';
import { MAX_DOC_BYTES, detectDocument, extractDocumentText } from './documents.js';
import { runRecognition } from './recognize.js';
import { readTenderPage } from './fetchPage.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 10;
const MAX_FILES_PER_TENDER = 20; // скриншотов
const MAX_DOCS_PER_TENDER = 10; // документов

const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });

/** Определяет тип изображения по содержимому, а не по имени файла. */
export function sniffImage(buf) {
  if (buf.length > 12) {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      return { mime: 'image/png', ext: '.png' };
    if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return { mime: 'image/gif', ext: '.gif' };
    if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP')
      return { mime: 'image/webp', ext: '.webp' };
  }
  return null;
}

/** Приводит введённую ссылку к виду http(s)://…; null — если это не ссылка. */
export function normalizeUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';
  if (s.length > 2000 || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.toString();
  } catch {
    return null;
  }
}

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function createApp({ db, config, recognizer, readPage = readTenderPage }) {
  const app = express();
  app.disable('x-powered-by');
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_DOC_BYTES, files: MAX_FILES_PER_REQUEST },
  });

  /* ----- защита без входа: приложение отвечает только на «свои» адреса ----- */
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...config.allowedHosts]);
  app.use((req, res, next) => {
    const host = String(req.get('host') || '').replace(/:\d+$/, '').toLowerCase();
    if (!allowedHosts.has(host)) {
      return res
        .status(403)
        .type('text')
        .send('Недопустимый адрес. Откройте приложение по адресу http://localhost или добавьте этот адрес в ALLOWED_HOSTS.');
    }
    next();
  });
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  // Чужие сайты в браузере не должны менять данные: изменяющие запросы принимаются только с этого же адреса.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin) {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        /* пустой host => отказ ниже */
      }
      if (host !== req.get('host')) return res.status(403).json({ error: 'Запрос отклонён (чужой источник)' });
    }
    next();
  });

  const api = express.Router();
  app.use('/api', api);

  api.get('/health', (_req, res) => res.json({ ok: true }));

  // Состояние распознавания: запущена ли Ollama и скачана ли модель.
  api.get('/config', async (_req, res) => {
    const st = recognizer.status ? await recognizer.status() : { ok: !!recognizer.configured, message: '' };
    res.json({ recognition: st.ok, recognition_note: st.message, model: recognizer.model || '' });
  });

  /* ----- закупки ----- */
  api.get('/tenders', (_req, res) => res.json(listTenders(db)));

  const getTender = (req) => {
    const row = findTender(db, Number(req.params.id));
    if (!row) throw httpError(404, 'Закупка не найдена');
    return row;
  };

  api.get('/tenders/:id', (req, res) => res.json(serializeTender(db, getTender(req))));

  // busboy отдаёт имя файла в latin1: если все символы ≤ 0xFF, это «испорченный» UTF-8.
  const fileName = (file) => {
    const raw = file.originalname || '';
    return [...raw].every((ch) => ch.charCodeAt(0) <= 0xff) ? Buffer.from(raw, 'latin1').toString('utf8') : raw;
  };

  /**
   * Проверяет загруженные файлы: изображения (по содержимому) и документы PDF / Word / Excel.
   * Из документов сразу извлекается текст; если файл нельзя прочитать — понятная ошибка, ничего не сохраняется.
   */
  async function validateFiles(files, have = { image: 0, document: 0 }) {
    const checked = [];
    let images = 0;
    let docs = 0;
    for (const file of files) {
      const name = str(fileName(file), 200);
      const img = sniffImage(file.buffer);
      if (img) {
        if (file.size > MAX_IMAGE_BYTES) {
          throw httpError(400, `Изображение «${name}» слишком большое (максимум ${MAX_IMAGE_BYTES / 1024 / 1024} МБ)`);
        }
        images += 1;
        checked.push({ file, name, kind: 'image', text: '', ...img });
        continue;
      }
      const doc = detectDocument(name, file.buffer);
      if (!doc) {
        throw httpError(
          400,
          `Файл «${name}» не подходит. Загрузите изображение (JPG, PNG, WEBP, GIF) или документ: PDF, Word (.docx, .doc), Excel (.xlsx).`,
        );
      }
      let text;
      try {
        text = await extractDocumentText(doc.kind, file.buffer, name);
      } catch (err) {
        throw httpError(400, err.message);
      }
      docs += 1;
      checked.push({ file, name, kind: 'document', text, mime: doc.mime, ext: doc.ext });
    }
    if (have.image + images > MAX_FILES_PER_TENDER) {
      throw httpError(400, `К одной закупке можно добавить не больше ${MAX_FILES_PER_TENDER} скриншотов`);
    }
    if (have.document + docs > MAX_DOCS_PER_TENDER) {
      throw httpError(400, `К одной закупке можно добавить не больше ${MAX_DOCS_PER_TENDER} документов`);
    }
    return checked;
  }

  const countFiles = (tenderId) => {
    const rows = db.prepare('SELECT kind, COUNT(*) AS c FROM tender_files WHERE tender_id = ? GROUP BY kind').all(tenderId);
    const out = { image: 0, document: 0 };
    for (const r of rows) out[r.kind] = Number(r.c);
    return out;
  };

  function storeFiles(tenderId, checked) {
    const insert = db.prepare(
      `INSERT INTO tender_files (tender_id, ordinal, filename, mime, size, stored_name, kind, extracted_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const next = { image: 0, document: 0 };
    for (const kind of Object.keys(next)) {
      next[kind] = db.prepare('SELECT COALESCE(MAX(ordinal), 0) AS m FROM tender_files WHERE tender_id = ? AND kind = ?').get(tenderId, kind).m;
    }
    for (const c of checked) {
      const stored = `${crypto.randomUUID()}${c.ext}`;
      fs.writeFileSync(path.join(config.uploadsDir, stored), c.file.buffer);
      next[c.kind] += 1;
      const fallback = c.kind === 'image' ? `Скриншот ${next[c.kind]}` : `Документ ${next[c.kind]}`;
      insert.run(tenderId, next[c.kind], c.name || fallback, c.mime, c.file.size, stored, c.kind, c.text);
    }
  }

  const recognizerFn = (args) => recognizer(args);

  // Новая закупка: ссылка и/или скриншоты → черновик + распознавание.
  api.post('/tenders/recognize', upload.array('files', MAX_FILES_PER_REQUEST), async (req, res) => {
    const files = req.files || [];
    const url = normalizeUrl(req.body?.url);
    const manual = req.body?.mode === 'manual';
    if (url === null) throw httpError(400, 'Ссылка введена неверно. Пример: https://example.com/tender/123');
    if (!manual && !url && files.length === 0) throw httpError(400, 'Добавьте ссылку на закупку, скриншоты или документы');
    const checked = await validateFiles(files);

    const tenderId = transaction(db, () => {
      const r = db
        .prepare('INSERT INTO tenders (url, url_status) VALUES (?, ?)')
        .run(url, url ? 'not_checked' : 'none');
      const id = Number(r.lastInsertRowid);
      storeFiles(id, checked);
      return id;
    });
    const result = manual
      ? { recognized: false, notices: [] }
      : await runRecognition({ db, config, recognizer: recognizerFn, tenderId, readPage });
    res.status(201).json({ tender: serializeTender(db, findTender(db, tenderId)), notices: result.notices });
  });

  // Повторное распознавание: можно добавить скриншоты и/или изменить ссылку.
  api.post('/tenders/:id/recognize', upload.array('files', MAX_FILES_PER_REQUEST), async (req, res) => {
    const row = getTender(req);
    const files = req.files || [];
    let url = row.url;
    if (req.body?.url !== undefined && String(req.body.url).trim() !== '') {
      const n = normalizeUrl(req.body.url);
      if (n === null) throw httpError(400, 'Ссылка введена неверно. Пример: https://example.com/tender/123');
      url = n;
    }
    const checked = await validateFiles(files, countFiles(row.id));
    transaction(db, () => {
      if (url !== row.url) {
        db.prepare("UPDATE tenders SET url = ?, url_status = 'not_checked', url_note = '' WHERE id = ?").run(url, row.id);
        const flags = JSON.parse(row.review_flags || '{}');
        delete flags.url;
        db.prepare('UPDATE tenders SET review_flags = ? WHERE id = ?').run(JSON.stringify(flags), row.id);
      }
      storeFiles(row.id, checked);
    });
    const result = await runRecognition({ db, config, recognizer: recognizerFn, tenderId: row.id, readPage });
    touchTender(db, row.id);
    res.json({ tender: serializeTender(db, getTender(req)), notices: result.notices, added: result.added || 0 });
  });

  api.patch('/tenders/:id', (req, res) => {
    const row = getTender(req);
    const b = req.body || {};
    const set = {};

    for (const [key, max] of [['company', 300], ['title', 1000], ['number', 200], ['deadline_tz', 60]]) {
      if (key in b) set[key] = str(b[key], max);
    }
    if ('type' in b) {
      if (b.type === '' || b.type === null) set.type = null;
      else if (b.type === 'Тендер' || b.type === 'ЗЦП') set.type = b.type;
      else throw httpError(400, 'Тип закупки: «Тендер» или «ЗЦП»');
    }
    if ('deadline_date' in b) {
      const d = b.deadline_date || null;
      if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw httpError(400, 'Дата указана неверно');
      set.deadline_date = d;
    }
    if ('deadline_time' in b) {
      const t = b.deadline_time || null;
      if (t !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw httpError(400, 'Время указано неверно');
      set.deadline_time = t;
    }
    if ('url' in b) {
      const u = normalizeUrl(b.url);
      if (u === null) throw httpError(400, 'Ссылка введена неверно. Пример: https://example.com/tender/123');
      set.url = u;
      if (u !== row.url) {
        set.url_status = u ? 'not_checked' : 'none';
        set.url_note = '';
      }
    }
    if (b.review_flags && typeof b.review_flags === 'object') {
      const flags = {};
      for (const k of REVIEW_KEYS) if (typeof b.review_flags[k] === 'string' && b.review_flags[k]) flags[k] = str(b.review_flags[k], 400);
      set.review_flags = JSON.stringify(flags);
    }
    if (typeof b.needs_requirements === 'boolean') set.needs_requirements = b.needs_requirements ? 1 : 0;
    if (b.save === true) set.is_draft = 0;

    const cols = Object.keys(set);
    if (cols.length) {
      db.prepare(
        `UPDATE tenders SET ${cols.map((c) => `${c} = ?`).join(', ')},
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      ).run(...cols.map((c) => set[c]), row.id);
    }
    res.json(serializeTender(db, getTender(req)));
  });

  api.delete('/tenders/:id', (req, res) => {
    const row = getTender(req);
    const files = db.prepare('SELECT stored_name FROM tender_files WHERE tender_id = ?').all(row.id);
    db.prepare('DELETE FROM tenders WHERE id = ?').run(row.id);
    for (const f of files) fs.rmSync(path.join(config.uploadsDir, f.stored_name), { force: true });
    res.json({ ok: true });
  });

  /* ----- пункты чек-листа ----- */
  api.post('/tenders/:id/items', (req, res) => {
    const row = getTender(req);
    const title = str(req.body?.title, 300);
    if (!title) throw httpError(400, 'Введите название пункта');
    const required = ['yes', 'no', 'unclear'].includes(req.body?.required) ? req.body.required : 'yes';
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM checklist_items WHERE tender_id = ?').get(row.id).p;
    const r = db
      .prepare(
        `INSERT INTO checklist_items (tender_id, position, title, required, source_type, assignee, comment)
         VALUES (?, ?, ?, ?, 'manual', ?, ?)`,
      )
      .run(row.id, pos, title, required, str(req.body?.assignee, 100), str(req.body?.comment, 2000));
    touchTender(db, row.id);
    res.status(201).json(serializeItem(db.prepare(ITEM_SQL).get(Number(r.lastInsertRowid))));
  });

  const getItem = (req) => {
    const item = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(Number(req.params.id));
    if (!item) throw httpError(404, 'Пункт не найден');
    return item;
  };

  api.patch('/items/:id', (req, res) => {
    const item = getItem(req);
    const b = req.body || {};
    const set = {};
    if ('title' in b) {
      set.title = str(b.title, 300);
      if (!set.title) throw httpError(400, 'Название пункта не может быть пустым');
    }
    if ('required' in b) {
      if (!['yes', 'no', 'unclear'].includes(b.required)) throw httpError(400, 'Неверное значение обязательности');
      set.required = b.required;
    }
    if ('status' in b) {
      if (!['todo', 'in_progress', 'done'].includes(b.status)) throw httpError(400, 'Неверный статус');
      set.status = b.status;
    }
    if ('assignee' in b) set.assignee = str(b.assignee, 100);
    if ('comment' in b) set.comment = String(b.comment ?? '').trim().slice(0, 2000);
    const cols = Object.keys(set);
    if (cols.length) {
      db.prepare(
        `UPDATE checklist_items SET ${cols.map((c) => `${c} = ?`).join(', ')},
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      ).run(...cols.map((c) => set[c]), item.id);
      touchTender(db, item.tender_id);
    }
    res.json(serializeItem(db.prepare(ITEM_SQL).get(item.id)));
  });

  api.delete('/items/:id', (req, res) => {
    const item = getItem(req);
    db.prepare('DELETE FROM checklist_items WHERE id = ?').run(item.id);
    touchTender(db, item.tender_id);
    res.json({ ok: true });
  });

  /* ----- скриншоты ----- */
  api.get('/files/:id', (req, res) => {
    const f = db.prepare('SELECT * FROM tender_files WHERE id = ?').get(Number(req.params.id));
    if (!f) throw httpError(404, 'Файл не найден');
    res.set('Cache-Control', 'private, max-age=86400');
    const abs = path.join(config.uploadsDir, f.stored_name);
    if (f.kind === 'document') return res.download(abs, f.filename); // документы скачиваются, а не открываются
    res.type(f.mime).sendFile(abs);
  });

  api.use((_req, res) => res.status(404).json({ error: 'Не найдено' }));

  /* ----- статика ----- */
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

  /* ----- ошибки ----- */
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const text =
        err.code === 'LIMIT_FILE_SIZE'
          ? `Файл слишком большой (максимум ${MAX_DOC_BYTES / 1024 / 1024} МБ)`
          : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
            ? `За один раз можно загрузить не больше ${MAX_FILES_PER_REQUEST} файлов`
            : 'Не удалось принять файлы';
      return res.status(413).json({ error: text });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный запрос' });
    if (err.expose) return res.status(err.status || 400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  return app;
}
