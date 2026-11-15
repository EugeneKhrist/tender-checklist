import fs from 'node:fs';
import path from 'node:path';
import { readTenderPage } from './fetchPage.js';
import { normalizeTitle, RecognitionError } from './extract.js';
import { transaction } from './db.js';
import { parseFlags } from './store.js';

const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';

/**
 * Читает ссылку и скриншоты закупки, вызывает распознавание и заполняет черновик.
 * Введённая пользователем ссылка и загруженные файлы сохраняются в любом случае.
 * При повторном запуске не затирает значения, которые пользователь уже подтвердил:
 * заполняются только пустые и помеченные «Требует проверки» поля,
 * а в чек-лист добавляются только новые пункты.
 */
export async function runRecognition({ db, config, recognizer, tenderId, readPage = readTenderPage }) {
  const tender = db.prepare('SELECT * FROM tenders WHERE id = ?').get(tenderId);
  const files = db.prepare('SELECT * FROM tender_files WHERE tender_id = ? ORDER BY kind DESC, ordinal').all(tenderId);
  const imageFiles = files.filter((f) => f.kind === 'image');
  const docFiles = files.filter((f) => f.kind === 'document');
  const notices = [];

  let page = null;
  if (tender.url) {
    page = await readPage(tender.url, { allowPrivate: config.allowPrivateFetch });
    db.prepare('UPDATE tenders SET url_status = ?, url_note = ? WHERE id = ?').run(
      page.status,
      page.message || '',
      tenderId,
    );
  } else {
    db.prepare("UPDATE tenders SET url_status = 'none', url_note = '' WHERE id = ?").run(tenderId);
  }
  const usablePage = page && page.status === 'ok' ? page : null;

  if (!usablePage && files.length === 0) {
    notices.push({
      level: 'error',
      text: tender.url
        ? 'Не удалось прочитать страницу по ссылке. Ссылка сохранена — загрузите скриншоты или документы, и распознавание продолжится по ним.'
        : 'Добавьте ссылку на закупку, скриншоты или документы.',
    });
    return { recognized: false, notices };
  }

  const images = imageFiles.map((f) => ({
    ordinal: f.ordinal,
    mime: f.mime,
    buffer: fs.readFileSync(path.join(config.uploadsDir, f.stored_name)),
  }));
  const documents = docFiles.map((f) => ({ ordinal: f.ordinal, name: f.filename, text: f.extracted_text }));

  let extraction;
  try {
    extraction = await recognizer({
      url: tender.url || null,
      page: usablePage,
      images,
      documents,
      today: new Date().toISOString().slice(0, 10),
    });
  } catch (err) {
    if (!(err instanceof RecognitionError)) console.error('Ошибка распознавания:', err);
    notices.push({
      level: 'error',
      text: err instanceof RecognitionError ? err.message : 'Распознавание не удалось из-за внутренней ошибки. Попробуйте ещё раз.',
    });
    return { recognized: false, notices };
  }

  const added = applyExtraction(db, tender, files, extraction, !!usablePage);
  for (const text of extraction.warnings || []) notices.push({ level: 'warn', text });
  if (!extraction.requirementsVisible) {
    notices.push({
      level: 'warn',
      text: 'В материалах не найдено требований к заявке — видна только карточка закупки. Добавьте страницы или документы с требованиями (скриншоты, PDF, Word, Excel или ссылку).',
    });
  } else if (added === 0 && extraction.items.length === 0) {
    notices.push({ level: 'info', text: 'Новых пунктов чек-листа не найдено.' });
  }
  return { recognized: true, added, notices };
}

export function applyExtraction(db, tender, files, ex, hasPage) {
  // Номера скриншотов и документов считаются отдельно.
  const byKind = {
    screenshot: new Map(files.filter((f) => f.kind === 'image').map((f) => [f.ordinal, f])),
    document: new Map(files.filter((f) => f.kind === 'document').map((f) => [f.ordinal, f])),
  };
  return transaction(db, () => {
    const flags = parseFlags(tender.review_flags);
    const set = {};

    for (const key of ['company', 'title', 'type', 'number']) {
      const writable = isEmpty(tender[key]) || flags[key];
      if (!writable) continue;
      if (ex.fields[key] !== null) set[key] = ex.fields[key];
      if (ex.review[key]) flags[key] = ex.review[key];
      else delete flags[key];
    }

    const deadlineWritable = (isEmpty(tender.deadline_date) && isEmpty(tender.deadline_time)) || flags.deadline;
    if (deadlineWritable) {
      set.deadline_date = ex.fields.deadline_date ?? tender.deadline_date;
      set.deadline_time = ex.fields.deadline_time ?? tender.deadline_time;
      set.deadline_tz = ex.fields.deadline_tz ?? tender.deadline_tz;
      set.deadline_raw = ex.fields.deadline_raw ?? tender.deadline_raw;
      if (ex.review.deadline) flags.deadline = ex.review.deadline;
      else delete flags.deadline;
    }

    if (isEmpty(tender.url) && ex.fields.url) {
      set.url = ex.fields.url;
      flags.url = ex.review.url || 'Ссылка взята из материалов — проверьте её';
    }

    set.needs_requirements = ex.requirementsVisible ? 0 : 1;
    set.review_flags = JSON.stringify(flags);

    const cols = Object.keys(set);
    db.prepare(
      `UPDATE tenders SET ${cols.map((c) => `${c} = ?`).join(', ')},
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).run(...cols.map((c) => set[c]), tender.id);

    const existing = db.prepare('SELECT title, position FROM checklist_items WHERE tender_id = ?').all(tender.id);
    const known = new Set(existing.map((r) => normalizeTitle(r.title)));
    let position = existing.reduce((m, r) => Math.max(m, r.position), 0);
    const insert = db.prepare(
      `INSERT INTO checklist_items (tender_id, position, title, required, source_type, source_file_id, excerpt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    for (const it of ex.items) {
      const key = normalizeTitle(it.title);
      if (known.has(key)) continue;
      known.add(key);
      let sourceType = 'link';
      let fileId = null;
      if (it.source === 'screenshot' || it.source === 'document') {
        const f = byKind[it.source].get(it.ordinal);
        sourceType = it.source;
        fileId = f ? f.id : null;
        if (!f && hasPage) sourceType = 'link';
      }
      position += 1;
      insert.run(tender.id, position, it.title, it.required, sourceType, fileId, it.excerpt);
      added += 1;
    }
    return added;
  });
}
