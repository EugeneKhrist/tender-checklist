import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTRACTION_SCHEMA, RecognitionError, checkExcerptsAgainstText, mergeExtractions, normalizeExtraction } from '../server/extract.js';
import { createOllamaRecognizer, splitText } from '../server/ollama.js';
import { PNG } from './helpers.js';

const answer = (obj) => ({ ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(obj) } }), text: async () => '' });
const base = {
  company: '', company_review: '', title: '', title_review: '', type: '', type_review: '', number: '', number_review: '',
  deadline_raw: '', deadline_date: '', deadline_time: '', deadline_timezone: '', deadline_review: '', direct_url: '',
  requirements_visible: false, checklist: [],
};

test('Ollama: по запросу на каждый скриншот, источник пункта известен точно', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    const isShot2 = body.messages[1].content.includes('Скриншот 2');
    return answer(
      isShot2
        ? { ...base, requirements_visible: true, checklist: [
            { title: 'Приложить ценовое предложение', required: 'yes', excerpt: 'необходимо приложить ценовое предложение' },
            { title: 'Приложить паспорт оборудования', required: 'yes', excerpt: 'и паспорт оборудования' },
          ] }
        : { ...base, company: 'ООО «Компания Б»', title: 'Поставка преобразователей', type: 'ЗЦП', number: 'Лот 77', deadline_raw: '20.12.2026 до 1', deadline_date: '2026-12-20', deadline_review: 'время обрезано' },
    );
  };
  const recognize = createOllamaRecognizer({ baseUrl: 'http://ollama.test', model: 'qwen2.5vl:7b', numCtx: 8192, fetchImpl });
  const ex = await recognize({
    url: null,
    page: null,
    images: [
      { ordinal: 1, mime: 'image/png', buffer: PNG },
      { ordinal: 2, mime: 'image/png', buffer: PNG },
    ],
    today: '2026-11-15',
  });

  assert.equal(requests.length, 2);
  for (const r of requests) {
    assert.equal(r.url, 'http://ollama.test/api/chat');
    assert.equal(r.body.model, 'qwen2.5vl:7b');
    assert.equal(r.body.stream, false);
    assert.deepEqual(r.body.format, JSON.parse(JSON.stringify(EXTRACTION_SCHEMA)));
    assert.equal(r.body.options.temperature, 0);
    assert.equal(r.body.options.num_ctx, 8192);
    assert.deepEqual(r.body.messages[1].images, [PNG.toString('base64')]);
  }
  assert.equal(ex.fields.company, 'ООО «Компания Б»');
  assert.ok(ex.review.deadline);
  assert.equal(ex.items.length, 2);
  assert.ok(ex.items.every((i) => i.source === 'screenshot' && i.ordinal === 2));
  assert.equal(ex.requirementsVisible, true);
});

test('Ollama: страница по ссылке режется на фрагменты; цитата вне текста понижает обязательность', async () => {
  const text = Array.from({ length: 300 }, (_, i) => `Строка ${i} с описанием требований закупки`).join('\n');
  const { chunks } = splitText(text, 2000, 8);
  assert.ok(chunks.length > 1 && chunks.every((c) => c.length <= 2200));

  const items = checkExcerptsAgainstText(
    [
      { title: 'Реальный', required: 'yes', source: 'link', screenshot_number: null, excerpt: 'Приложить ценовое предложение' },
      { title: 'Выдуманный', required: 'yes', source: 'link', screenshot_number: null, excerpt: 'Нотариально заверенная копия устава' },
      { title: 'Со скриншота', required: 'yes', source: 'screenshot', screenshot_number: 1, excerpt: 'нет в тексте' },
    ],
    'К заявке необходимо приложить ценовое предложение и паспорт',
  );
  assert.deepEqual(items.map((i) => i.required), ['yes', 'unclear', 'yes']);
});

test('объединение источников: расхождения помечаются, срок берётся из самого полного', () => {
  const a = normalizeExtraction({ ...base, company: 'ООО «А»', title: 'Датчики', type: 'ЗЦП', number: '1', deadline_date: '2026-12-20', deadline_raw: '20.12.2026' });
  const b = normalizeExtraction({ ...base, company: 'ООО «Б»', title: 'Датчики', type: 'ЗЦП', number: '1', deadline_date: '2026-12-20', deadline_time: '10:00', deadline_raw: '20.12.2026 10:00' });
  const m = mergeExtractions([a, b]);
  assert.equal(m.fields.company, 'ООО «А»');
  assert.match(m.review.company, /разные значения/);
  assert.equal(m.fields.deadline_time, '10:00');
  assert.equal(m.review.deadline, undefined, 'полный срок из второго источника снимает пометку');
  assert.equal(m.review.title, undefined);
});

test('пример из задания на реальных ответах модели: ложный пункт и ложный конфликт не проходят', () => {
  // Ответы qwen2.5vl:7b по двум скриншотам ЗЦП (скриншот 1 — карточка, 2 — требования).
  const shot1 = normalizeExtraction({
    ...base, company: 'ООО «Компания Б»', title: 'Поставка преобразователей напряжения 24 В → 12 В', type: 'ЗЦП', number: 'Лот № 77',
    deadline_raw: '20.12.2026 до 1', deadline_date: '2026-12-20', requirements_visible: true,
    checklist: [{ title: 'Приложить ценовое предложение', required: 'yes', excerpt: 'Запрос ценовых предложений', source: 'screenshot', ordinal: 1 }],
  });
  const shot2 = normalizeExtraction({
    ...base, company_review: 'Название заказчика не видно.', title: 'Требования к заявке', type: 'ЗЦП', requirements_visible: true,
    checklist: [
      { title: 'Приложить ценовое предложение', required: 'yes', excerpt: 'К заявке необходимо приложить ценовое предложение и паспорт оборудования.', source: 'screenshot', ordinal: 2 },
      { title: 'Приложить паспорт оборудования', required: 'yes', excerpt: 'К заявке необходимо приложить ценовое предложение и паспорт оборудования.', source: 'screenshot', ordinal: 2 },
    ],
  });
  const m = mergeExtractions([shot1, shot2]);
  assert.equal(m.fields.title, 'Поставка преобразователей напряжения 24 В → 12 В');
  assert.equal(m.review.title, undefined, 'заголовок раздела на странице требований не даёт ложного конфликта');
  assert.ok(m.review.deadline, 'обрезанный срок по-прежнему помечен');
  assert.equal(m.items.length, 2);
  assert.ok(m.items.every((i) => i.required === 'yes' && i.ordinal === 2), 'пункты взяты со скриншота 2, где есть настоящая цитата');

  // Только страница требований, без реквизитов: поля заполнены «на всякий случай» и помечены.
  const only = mergeExtractions([shot2]);
  assert.equal(only.fields.title, 'Требования к заявке');
  assert.match(only.review.title, /без реквизитов/);

  // Пункт, цитата которого не выражает требование, остаётся только как «на проверке».
  const lone = mergeExtractions([shot1]);
  assert.equal(lone.items[0].required, 'unclear');
});

test('Ollama: понятные ошибки и состояние', async () => {
  const down = createOllamaRecognizer({ baseUrl: 'http://x', model: 'm', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(() => down({ page: { text: 'abc' }, images: [], today: '' }), /Ollama/);
  assert.equal((await down.status()).ok, false);

  const noModel = createOllamaRecognizer({ baseUrl: 'http://x', model: 'qwen2.5vl:7b', fetchImpl: async () => ({ ok: false, status: 404, text: async () => 'model "qwen2.5vl:7b" not found' }) });
  await assert.rejects(() => noModel({ page: { text: 'abc' }, images: [], today: '' }), /ollama pull qwen2\.5vl:7b/);

  const tags = (names) => async () => ({ ok: true, status: 200, json: async () => ({ models: names.map((name) => ({ name })) }) });
  assert.equal((await createOllamaRecognizer({ baseUrl: 'http://x', model: 'qwen2.5vl:7b', fetchImpl: tags(['qwen2.5vl:7b']) }).status()).ok, true);
  const missing = await createOllamaRecognizer({ baseUrl: 'http://x', model: 'qwen2.5vl:7b', fetchImpl: tags(['llama3:latest']) }).status();
  assert.equal(missing.ok, false);
  assert.match(missing.message, /ollama pull/);

  let calls = 0;
  const junk = createOllamaRecognizer({ baseUrl: 'http://x', model: 'm', fetchImpl: async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ message: { content: 'не JSON' } }) }; } });
  await assert.rejects(() => junk({ page: null, images: [{ ordinal: 1, mime: 'image/png', buffer: PNG }], today: '' }), RecognitionError);
  assert.equal(calls, 2, 'одна повторная попытка');
});
