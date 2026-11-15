import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { detectDocument, extractDocumentText } from '../server/documents.js';
import { openDb } from '../server/db.js';
import { normalizeExtraction } from '../server/extract.js';
import { readTenderPage } from '../server/fetchPage.js';
import { createOllamaRecognizer } from '../server/ollama.js';
import { PNG, startFakeSite, startTestApp } from './helpers.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

/** Минимальный настоящий .docx: абзацы + таблица (русский текст). */
async function makeDocx() {
  const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const cell = (t) => `<w:tc>${p(t)}</w:tc>`;
  const row = (a, b) => `<w:tr>${cell(a)}${cell(b)}</w:tr>`;
  const body = [
    p('Извещение о запросе ценовых предложений № 55'),
    p('Заказчик: ООО «Компания В»'),
    p('Срок окончания подачи предложений: 05.03.2027 12:00 (МСК)'),
    `<w:tbl>${row('Документ', 'Обязательность')}${row('Гарантийное письмо', 'Обязательно')}</w:tbl>`,
  ].join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makeXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Спецификация');
  ws.addRow(['Позиция', 'Наименование', 'Кол-во']);
  ws.addRow([1, 'Датчик вибрации ДВ-12', 4]);
  ws.addRow(['Срок поставки', 'до 30.01.2027', '']);
  ws.addRow(['Требование', 'Приложить паспорт оборудования']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('документы: PDF, Word (.docx) и Excel (.xlsx) → текст', async () => {
  const pdf = await extractDocumentText('pdf', fixture('tender.pdf'), 'tender.pdf');
  assert.match(pdf, /Заказчик: ООО «Компания Б»/);
  assert.match(pdf, /паспорт оборудования/);
  assert.match(pdf, /Ценовое предложение Обязательно/);

  const docx = await extractDocumentText('docx', await makeDocx(), 'x.docx');
  assert.match(docx, /Компания В/);
  assert.match(docx, /Гарантийное письмо \| Обязательно/, 'таблица Word читается построчно');

  const xlsx = await extractDocumentText('xlsx', await makeXlsx(), 'x.xlsx');
  assert.match(xlsx, /\[лист «Спецификация»\]/);
  assert.match(xlsx, /Датчик вибрации ДВ-12 \| 4/);
  assert.match(xlsx, /Приложить паспорт оборудования/);
});

test('старый .doc читается (нужен настоящий файл test/fixtures/tender.doc)', { skip: !fs.existsSync(new URL('./fixtures/tender.doc', import.meta.url)) }, async () => {
  const text = await extractDocumentText('doc', fixture('tender.doc'), 'tender.doc');
  assert.match(text, /Компания Б/);
});

test('документы: тип определяется по содержимому; сканы и битые файлы дают понятную ошибку', async () => {
  assert.equal(detectDocument('a.pdf', fixture('tender.pdf')).kind, 'pdf');
  assert.equal(detectDocument('a.docx', await makeDocx()).kind, 'docx');
  assert.equal(detectDocument('a.xlsx', await makeXlsx()).kind, 'xlsx');
  assert.equal(detectDocument('A.PDF', fixture('tender.pdf')).kind, 'pdf', 'регистр расширения не важен');
  assert.equal(detectDocument('a.docx', Buffer.from('просто текст, не архив')), null);
  assert.equal(detectDocument('a.pdf', await makeDocx()), null, 'расширение не совпадает с содержимым');
  assert.equal(detectDocument('a.exe', Buffer.from('MZ')), null);

  const empty = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF');
  await assert.rejects(() => extractDocumentText('pdf', empty, 'scan.pdf'), /scan\.pdf/);
  await assert.rejects(() => extractDocumentText('docx', Buffer.from('PK\x03\x04мусор'), 'bad.docx'), /bad\.docx/);
});

test('загрузка документов: текст попадает в распознавание, источник пункта — документ', async () => {
  const seen = [];
  const recognizer = Object.assign(
    async (input) => {
      seen.push(input);
      return normalizeExtraction({
        company: 'ООО «Компания Б»',
        title: 'Поставка преобразователей',
        type: 'ЗЦП',
        number: '2026-ЗЦП-77',
        deadline_raw: '20.12.2026 17:00 (МСК)',
        deadline_date: '2026-12-20',
        deadline_time: '17:00',
        deadline_timezone: 'МСК',
        requirements_visible: true,
        checklist: [
          { title: 'Приложить ценовое предложение', required: 'yes', source: 'document', ordinal: 1, excerpt: 'приложить ценовое предложение и паспорт оборудования' },
          { title: 'Приложить паспорт оборудования', required: 'yes', source: 'document', ordinal: 1, excerpt: 'паспорт оборудования' },
          { title: 'Приложить спецификацию', required: 'yes', source: 'document', ordinal: 2, excerpt: 'Приложить паспорт оборудования' },
        ],
      });
    },
    { configured: true },
  );
  const app = await startTestApp({ recognizer });
  try {
    const fd = new FormData();
    fd.append('files', new Blob([fixture('tender.pdf')], { type: 'application/pdf' }), 'Извещение.pdf');
    fd.append('files', new Blob([await makeXlsx()]), 'Спецификация.xlsx');
    fd.append('files', new Blob([PNG], { type: 'image/png' }), 'скрин.png');
    const r = await app.api.raw('POST', '/api/tenders/recognize', fd);
    assert.equal(r.status, 201, r.text);
    const t = r.json.tender;

    assert.deepEqual(seen[0].documents.map((d) => [d.ordinal, d.name]), [[1, 'Извещение.pdf'], [2, 'Спецификация.xlsx']]);
    assert.match(seen[0].documents[0].text, /Компания Б/);
    assert.equal(seen[0].images.length, 1);

    assert.equal(t.company, 'ООО «Компания Б»');
    assert.deepEqual(t.files.map((f) => [f.kind, f.ordinal, f.filename]).sort(), [['document', 1, 'Извещение.pdf'], ['document', 2, 'Спецификация.xlsx'], ['image', 1, 'скрин.png']]);
    assert.ok(t.items.every((i) => i.source_type === 'document' && i.source_file_id));
    assert.deepEqual(t.items.map((i) => i.source_name), ['Извещение.pdf', 'Извещение.pdf', 'Спецификация.xlsx']);

    // документ скачивается как вложение, с русским именем
    const doc = t.files.find((f) => f.kind === 'document' && f.ordinal === 1);
    const dl = await app.api.raw('GET', `/api/files/${doc.id}`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), /attachment/);
    assert.match(decodeURIComponent(dl.headers.get('content-disposition')), /Извещение\.pdf/);

    // повторная загрузка: нумерация документов продолжается
    const fd2 = new FormData();
    fd2.append('files', new Blob([await makeDocx()]), 'Приложение.docx');
    const again = await app.api.raw('POST', `/api/tenders/${t.id}/recognize`, fd2);
    assert.equal(again.status, 200, again.text);
    assert.ok(again.json.tender.files.some((f) => f.kind === 'document' && f.ordinal === 3 && f.filename === 'Приложение.docx'));
    assert.match(seen[1].documents.at(-1).text, /Компания В/);
  } finally {
    await app.close();
  }
});

test('загрузка: неподходящие и нечитаемые файлы отклоняются целиком', async () => {
  const app = await startTestApp();
  try {
    const bad = async (blob, name) => {
      const fd = new FormData();
      fd.append('files', blob, name);
      return app.api.raw('POST', '/api/tenders/recognize', fd);
    };
    const exe = await bad(new Blob(['MZ\x90\x00 programma']), 'setup.exe');
    assert.equal(exe.status, 400);
    assert.match(exe.json.error, /PDF, Word/);
    const fake = await bad(new Blob(['это не docx, а текст']), 'doc.docx');
    assert.equal(fake.status, 400);
    const xls = await bad(new Blob([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])]), 'old.xls');
    assert.equal(xls.status, 400, '.xls не поддерживается');
    assert.equal((await app.api.get('/api/tenders')).json.length, 0, 'ничего не сохранилось');
  } finally {
    await app.close();
  }
});

test('ссылка на PDF читается как текст', async () => {
  const site = await startFakeSite();
  try {
    const page = await readTenderPage(`${site.base}/pdf`, { allowPrivate: true });
    assert.equal(page.status, 'ok');
    assert.match(page.text, /Компания Б/);
  } finally {
    await site.close();
  }
});

test('Ollama: документы читаются по фрагментам, источник и цитаты проверяются', async () => {
  const prompts = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    prompts.push(body.messages[1].content);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        message: {
          content: JSON.stringify({
            company: '', company_review: '', title: '', title_review: '', type: '', type_review: '', number: '', number_review: '',
            deadline_raw: '', deadline_date: '', deadline_time: '', deadline_timezone: '', deadline_review: '', direct_url: '',
            requirements_visible: true,
            checklist: [
              { title: 'Приложить паспорт оборудования', required: 'yes', excerpt: 'приложить ценовое предложение и паспорт оборудования' },
              { title: 'Нотариальная копия устава', required: 'yes', excerpt: 'нотариально заверенная копия устава' },
            ],
          }),
        },
      }),
    };
  };
  const recognize = createOllamaRecognizer({ baseUrl: 'http://x', model: 'm', fetchImpl });
  const text = await extractDocumentText('pdf', fixture('tender.pdf'), 'Извещение.pdf');
  const ex = await recognize({ page: null, images: [], documents: [{ ordinal: 2, name: 'Извещение.pdf', text }] });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /документ «Извещение\.pdf»/);
  assert.ok(ex.items.every((i) => i.source === 'document' && i.ordinal === 2));
  assert.deepEqual(ex.items.map((i) => i.required), ['yes', 'unclear'], 'цитата, которой нет в документе, понижает обязательность');
});

test('миграция: база прежней версии получает документы без потери данных', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-mig-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE tenders (id INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
      type TEXT CHECK (type IN ('Тендер','ЗЦП')), number TEXT NOT NULL DEFAULT '', deadline_date TEXT, deadline_time TEXT,
      deadline_tz TEXT NOT NULL DEFAULT '', deadline_raw TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
      url_status TEXT NOT NULL DEFAULT 'none', url_note TEXT NOT NULL DEFAULT '', review_flags TEXT NOT NULL DEFAULT '{}',
      is_draft INTEGER NOT NULL DEFAULT 1, needs_requirements INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT 'x', updated_at TEXT NOT NULL DEFAULT 'x');
    CREATE TABLE tender_files (id INTEGER PRIMARY KEY AUTOINCREMENT, tender_id INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, stored_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT 'x');
    CREATE TABLE checklist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, tender_id INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, required TEXT NOT NULL DEFAULT 'unclear' CHECK (required IN ('yes','no','unclear')),
      source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('link','screenshot','manual')),
      source_file_id INTEGER REFERENCES tender_files(id) ON DELETE SET NULL, excerpt TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')), assignee TEXT NOT NULL DEFAULT '',
      comment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT 'x', updated_at TEXT NOT NULL DEFAULT 'x');
    INSERT INTO tenders (company, title) VALUES ('ООО «Старая»', 'Старая закупка');
    INSERT INTO tender_files (tender_id, ordinal, filename, mime, size, stored_name) VALUES (1, 1, 'a.png', 'image/png', 10, 'x.png');
    INSERT INTO checklist_items (tender_id, position, title, required, source_type, source_file_id, status) VALUES (1, 1, 'Старый пункт', 'yes', 'screenshot', 1, 'done');
  `);
  old.close();

  const db = openDb(file);
  const file1 = db.prepare('SELECT kind, extracted_text FROM tender_files WHERE id = 1').get();
  assert.equal(file1.kind, 'image');
  const item = db.prepare('SELECT title, status, source_type, source_file_id FROM checklist_items WHERE id = 1').get();
  assert.deepEqual({ ...item }, { title: 'Старый пункт', status: 'done', source_type: 'screenshot', source_file_id: 1 });
  db.prepare("INSERT INTO checklist_items (tender_id, title, source_type) VALUES (1, 'Из документа', 'document')").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM checklist_items').get().c, 2);
  db.close();
  openDb(file).close(); // повторное открытие безопасно
  fs.rmSync(dir, { recursive: true, force: true });
});
