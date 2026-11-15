import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { normalizeExtraction } from '../server/extract.js';
import { isPrivateIp, extractText, readTenderPage } from '../server/fetchPage.js';
import { formWith, startFakeSite, startTestApp } from './helpers.js';

/* ---------- ответ «модели» для примера из задания: ЗЦП компании Б, два скриншота ---------- */
const ZCP_RAW = {
  company: 'ООО «Компания Б»',
  company_review: '',
  title: 'Поставка преобразователей напряжения 24 В → 12 В',
  title_review: '',
  type: 'ЗЦП',
  type_review: '',
  number: 'Лот № 77',
  number_review: '',
  deadline_raw: '20.12.2026 до 1',
  deadline_date: '2026-12-20',
  deadline_time: '',
  deadline_timezone: '',
  deadline_review: 'Время обрезано на скриншоте',
  direct_url: '',
  requirements_visible: true,
  checklist: [
    { title: 'Приложить ценовое предложение', required: 'yes', source: 'screenshot', screenshot_number: 2, excerpt: 'К заявке необходимо приложить ценовое предложение' },
    { title: 'Приложить паспорт оборудования', required: 'yes', source: 'screenshot', screenshot_number: 2, excerpt: 'и паспорт оборудования' },
  ],
};
const recognizerFor = (raw) => Object.assign(async () => normalizeExtraction(structuredClone(raw)), { configured: true });

test('normalizeExtraction: неполный срок и пустые поля получают «Требует проверки»', () => {
  const ex = normalizeExtraction({
    company: '',
    title: 'Датчики',
    type: 'что-то странное',
    number: '',
    deadline_raw: '15.12 17:',
    deadline_date: '2026-13-45',
    deadline_time: '17:',
    checklist: [
      { title: 'Паспорт', required: 'maybe', source: 'link', screenshot_number: 3, excerpt: 'x' },
      { title: ' паспорт. ', required: 'yes', source: 'link', screenshot_number: null, excerpt: 'дубль' },
    ],
  });
  assert.equal(ex.fields.type, null);
  assert.equal(ex.fields.deadline_date, null);
  assert.equal(ex.fields.deadline_time, null);
  for (const key of ['company', 'type', 'number', 'deadline']) assert.ok(ex.review[key], `нет пометки для ${key}`);
  assert.equal(ex.review.title, undefined);
  assert.equal(ex.items.length, 1, 'дубликаты по названию схлопываются');
  assert.equal(ex.items[0].required, 'unclear');
  assert.equal(ex.items[0].ordinal, null);
});

test('isPrivateIp / extractText', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1'])
    assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
  const { text } = extractText('<html><head><title>T</title><style>p{}</style></head><body><p>Привет</p><script>x()</script><table><tr><td>a</td><td>b</td></tr></table></body></html>');
  assert.match(text, /Привет/);
  assert.doesNotMatch(text, /x\(\)/);
  assert.match(text, /a \| b/);
});

test('readTenderPage: windows-1251, вход, SPA, SSRF', async () => {
  const site = await startFakeSite();
  try {
    const ok = await readTenderPage(`${site.base}/ok`, { allowPrivate: true });
    assert.equal(ok.status, 'ok');
    assert.match(ok.text, /Компания А/);
    assert.match(ok.text, /ценовое предложение/);
    assert.doesNotMatch(ok.text, /secret/);

    assert.equal((await readTenderPage(`${site.base}/forbidden`, { allowPrivate: true })).status, 'login_required');
    assert.equal((await readTenderPage(`${site.base}/wall`, { allowPrivate: true })).status, 'login_required');
    assert.equal((await readTenderPage(`${site.base}/spa`, { allowPrivate: true })).status, 'empty');
    assert.equal((await readTenderPage(`${site.base}/nope`, { allowPrivate: true })).status, 'unreachable');

    const blocked = await readTenderPage(`${site.base}/ok`, { allowPrivate: false });
    assert.equal(blocked.status, 'unreachable', 'локальные адреса по умолчанию закрыты');
  } finally {
    await site.close();
  }
});

test('сценарий из задания: скриншоты ЗЦП → карточка и два обязательных пункта', async () => {
  const app = await startTestApp({ recognizer: recognizerFor(ZCP_RAW) });
  try {
    const { api } = app;
    const r = await api.raw('POST', '/api/tenders/recognize', formWith({ files: 2 }));
    assert.equal(r.status, 201, r.text);
    const t = r.json.tender;
    assert.equal(t.company, 'ООО «Компания Б»');
    assert.equal(t.type, 'ЗЦП');
    assert.equal(t.url, '', 'ссылку можно добавить позже');
    assert.ok(t.review_flags.deadline, 'срок помечен «Требует проверки»');
    assert.equal(t.deadline_time, null);
    assert.equal(t.is_draft, true);
    assert.equal(t.items.length, 2);
    assert.ok(t.items.every((i) => i.required === 'yes' && i.source_type === 'screenshot' && i.source_ordinal === 2));
    assert.ok(t.items.every((i) => i.excerpt));
    assert.equal(t.files.length, 2);
    assert.deepEqual(t.progress, { required_total: 2, required_done: 0, unclear: 0, total_items: 2 });

    const saved = await api.patch(`/api/tenders/${t.id}`, {
      deadline_time: '17:00',
      deadline_tz: 'МСК',
      url: 'example.com/zcp/77',
      review_flags: {},
      save: true,
    });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.url, 'https://example.com/zcp/77');
    assert.equal(saved.json.is_draft, false);
    assert.deepEqual(saved.json.review_flags, {});

    const done = await api.patch(`/api/items/${t.items[0].id}`, { status: 'done' });
    assert.equal(done.json.status, 'done');
    const list = await api.get('/api/tenders');
    assert.equal(list.json[0].progress.required_done, 1);
    assert.equal(list.json[0].progress.required_total, 2);

    const img = await api.raw('GET', `/api/files/${t.files[0].id}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');

    assert.equal((await api.delete(`/api/tenders/${t.id}`)).status, 200);
    assert.equal((await api.get(`/api/tenders/${t.id}`)).status, 404);
  } finally {
    await app.close();
  }
});

test('ссылка на тендер читается; закрытая ссылка сохраняется и не ломает черновик', async () => {
  const site = await startFakeSite();
  const calls = [];
  const recognizer = Object.assign(
    async (input) => {
      calls.push(input);
      return normalizeExtraction({
        company: 'ООО «Компания А»',
        title: 'Поставка датчиков вибрации',
        type: 'Тендер',
        number: '0123-45',
        deadline_raw: '15.12.2026 17:00 МСК',
        deadline_date: '2026-12-15',
        deadline_time: '17:00',
        deadline_timezone: 'МСК',
        requirements_visible: true,
        checklist: [{ title: 'Приложить ценовое предложение', required: 'yes', source: 'link', screenshot_number: null, excerpt: 'необходимо приложить ценовое предложение' }],
      });
    },
    { configured: true },
  );
  const app = await startTestApp({ recognizer });
  try {
    const { api } = app;
    const ok = await api.raw('POST', '/api/tenders/recognize', formWith({ url: `${site.base}/ok` }));
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.tender.company, 'ООО «Компания А»');
    assert.equal(ok.json.tender.url, `${site.base}/ok`);
    assert.equal(ok.json.tender.url_status, 'ok');
    assert.match(calls[0].page.text, /Компания А/, 'модель получила текст страницы');
    assert.equal(ok.json.tender.items[0].source_type, 'link');
    assert.equal(ok.json.tender.deadline_tz, 'МСК');
    assert.deepEqual(ok.json.tender.review_flags, {});

    calls.length = 0;
    const closed = await api.raw('POST', '/api/tenders/recognize', formWith({ url: `${site.base}/wall` }));
    assert.equal(closed.status, 201);
    assert.equal(calls.length, 0, 'без доступных материалов модель не вызывается');
    assert.equal(closed.json.tender.url, `${site.base}/wall`, 'введённая ссылка сохранена');
    assert.equal(closed.json.tender.url_status, 'login_required');
    assert.ok(closed.json.notices.some((n) => n.level === 'error'));

    const again = await api.raw('POST', `/api/tenders/${closed.json.tender.id}/recognize`, formWith({ files: 1 }));
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.tender.company, 'ООО «Компания А»');
    assert.equal(again.json.tender.url, `${site.base}/wall`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].page, null);
    assert.equal(calls[0].images.length, 1);

    assert.equal((await api.raw('POST', '/api/tenders/recognize', formWith({ url: 'не ссылка' }))).status, 400);
    assert.equal((await api.raw('POST', '/api/tenders/recognize', formWith({ url: 'javascript:alert(1)' }))).status, 400);
  } finally {
    await app.close();
    await site.close();
  }
});

test('только карточка на скриншоте → просим страницы с требованиями; повторный запуск не затирает правки', async () => {
  let round = 0;
  const recognizer = Object.assign(
    async () => {
      round += 1;
      return normalizeExtraction(
        round === 1
          ? { company: 'ООО «Б»', title: 'Преобразователи', type: 'ЗЦП', number: '5', deadline_raw: '01.02.2027', deadline_date: '2027-02-01', deadline_time: '10:00', requirements_visible: false, checklist: [] }
          : { company: 'ЧУЖОЕ', title: 'Преобразователи', type: 'ЗЦП', number: '5', deadline_raw: '01.02.2027 10:00', deadline_date: '2027-02-01', deadline_time: '10:00', requirements_visible: true, checklist: [{ title: 'Паспорт', required: 'yes', source: 'screenshot', screenshot_number: 2, excerpt: 'паспорт' }] },
      );
    },
    { configured: true },
  );
  const app = await startTestApp({ recognizer });
  try {
    const { api } = app;
    const first = await api.raw('POST', '/api/tenders/recognize', formWith({ files: 1 }));
    const t = first.json.tender;
    assert.equal(t.needs_requirements, true);
    assert.equal(t.items.length, 0);
    assert.ok(first.json.notices.some((n) => /требовани/.test(n.text)));

    await api.patch(`/api/tenders/${t.id}`, { company: 'Моя редакция' });
    const second = await api.raw('POST', `/api/tenders/${t.id}/recognize`, formWith({ files: 1 }));
    assert.equal(second.json.tender.company, 'Моя редакция', 'подтверждённое поле не затёрто');
    assert.equal(second.json.tender.needs_requirements, false);
    assert.equal(second.json.tender.items.length, 1);
    assert.equal(second.json.tender.items[0].source_ordinal, 2);
  } finally {
    await app.close();
  }
});

test('чек-лист: добавить, исправить, удалить; ручная карточка без распознавания', async () => {
  const app = await startTestApp();
  try {
    const { api } = app;
    const created = await api.raw('POST', '/api/tenders/recognize', formWith({ mode: 'manual' }));
    assert.equal(created.status, 201);
    const id = created.json.tender.id;
    const item = (await api.post(`/api/tenders/${id}/items`, { title: 'Подтвердить срок поставки', required: 'unclear' })).json;
    assert.equal(item.source_type, 'manual');
    const upd = await api.patch(`/api/items/${item.id}`, { required: 'yes', assignee: 'Я', comment: 'позвонить', status: 'in_progress' });
    assert.deepEqual([upd.json.required, upd.json.assignee, upd.json.status], ['yes', 'Я', 'in_progress']);
    assert.equal((await api.patch(`/api/items/${item.id}`, { status: 'wat' })).status, 400);
    assert.equal((await api.delete(`/api/items/${item.id}`)).status, 200);
    assert.equal((await api.get(`/api/tenders/${id}`)).json.items.length, 0);
  } finally {
    await app.close();
  }
});

test('защита без входа: чужой Host, чужой Origin и не-изображения отклоняются', async () => {
  const app = await startTestApp();
  try {
    const fd = new FormData();
    fd.append('files', new Blob(['<html>not an image</html>'], { type: 'image/png' }), 'x.png');
    assert.equal((await app.api.raw('POST', '/api/tenders/recognize', fd)).status, 400);

    const evilOrigin = await app.api.raw('POST', '/api/tenders/recognize', formWith({ mode: 'manual' }), { origin: 'https://evil.example' });
    assert.equal(evilOrigin.status, 403);

    // DNS-rebinding: запрос приходит на наш порт, но с чужим именем хоста.
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${app.base}/api/tenders`, { headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
    assert.equal((await app.api.get('/api/tenders')).status, 200);
  } finally {
    await app.close();
  }
});
