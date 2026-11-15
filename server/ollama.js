import {
  EXTRACTION_SCHEMA,
  RecognitionError,
  SYSTEM_PROMPT,
  checkExcerptsAgainstText,
  mergeExtractions,
  normalizeExtraction,
} from './extract.js';

const CHUNK_CHARS = 6000;
const MAX_CHUNKS = 10;
const REQUEST_TIMEOUT_MS = 15 * 60_000;

/** Делит текст страницы на фрагменты по строкам: маленькой локальной модели проще работать с короткими кусками. */
export function splitText(text, size = CHUNK_CHARS, max = MAX_CHUNKS) {
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > size) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line.slice(0, size);
  }
  if (cur) chunks.push(cur);
  return { chunks: chunks.slice(0, max), truncated: chunks.length > max };
}

/**
 * Распознавание через локальную модель Ollama (ключей и интернета не требует).
 * Каждый скриншот и каждый фрагмент текста (страницы или документа) обрабатывается отдельным запросом —
 * так надёжнее для небольшой модели, а источник каждого пункта известен точно.
 */
export function createOllamaRecognizer({ baseUrl, model, numCtx = 16384, maxChunks = MAX_CHUNKS, fetchImpl = fetch }) {
  const explainNetwork = (err) => {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return new RecognitionError('Модель отвечает слишком долго (больше 15 минут). Попробуйте меньше скриншотов за раз или модель полегче.');
    }
    return new RecognitionError(
      `Не удаётся связаться с Ollama (${baseUrl}). Запустите приложение Ollama и повторите попытку.`,
    );
  };

  async function chat(userContent, images) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          model,
          stream: false,
          format: EXTRACTION_SCHEMA,
          keep_alive: '30m',
          options: { temperature: 0, num_ctx: numCtx },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent, ...(images ? { images } : {}) },
          ],
        }),
      });
    } catch (err) {
      throw explainNetwork(err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 404 || /not found/i.test(body)) {
        throw new RecognitionError(`Модель «${model}» не скачана. Выполните в терминале: ollama pull ${model}`);
      }
      throw new RecognitionError(`Ollama вернула ошибку ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const data = await res.json();
    try {
      return JSON.parse(data?.message?.content ?? '');
    } catch {
      return null;
    }
  }

  /** Один источник → нормализованный результат (или null, если модель не вернула разборчивый JSON). */
  async function extractOne(userContent, images, source, ordinal) {
    let raw = await chat(userContent, images);
    if (raw === null) raw = await chat(userContent, images); // одна повторная попытка
    if (raw === null) return null;
    raw.checklist = (Array.isArray(raw.checklist) ? raw.checklist : []).map((it) => ({
      ...it,
      source,
      ordinal: source === 'link' ? null : ordinal,
    }));
    return normalizeExtraction(raw);
  }

  async function status() {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    } catch {
      return { ok: false, message: 'Ollama не запущена. Запустите приложение Ollama — тогда заработает распознавание.' };
    }
    if (!res.ok) return { ok: false, message: `Ollama ответила ошибкой ${res.status}.` };
    const data = await res.json().catch(() => ({}));
    const names = (data.models || []).map((m) => m.name || m.model);
    const wanted = model.includes(':') ? model : `${model}:latest`;
    if (!names.includes(wanted)) {
      return { ok: false, message: `Ollama запущена, но модель «${model}» не скачана. Выполните: ollama pull ${model}` };
    }
    return { ok: true, message: '' };
  }

  async function recognize({ page, images = [], documents = [] }) {
    const parts = [];
    const warnings = [];
    let failed = 0;

    /** Текстовый источник (страница по ссылке или документ) → фрагменты → по запросу на фрагмент. */
    async function readText({ text, label, source, ordinal }) {
      const { chunks, truncated } = splitText(text, CHUNK_CHARS, maxChunks);
      if (truncated) warnings.push(`${label}: очень длинный текст — прочитано только начало (${chunks.length} фрагментов).`);
      for (let i = 0; i < chunks.length; i += 1) {
        const prompt = `Фрагмент ${i + 1} из ${chunks.length}. Источник: ${label}.\n<text>\n${chunks[i]}\n</text>\nЗаполни JSON.`;
        const part = await extractOne(prompt, null, source, ordinal);
        if (part) {
          part.items = checkExcerptsAgainstText(part.items, chunks[i]);
          parts.push(part);
        } else failed += 1;
      }
    }

    if (page?.text) {
      await readText({ text: page.text, label: `страница по ссылке${page.title ? ` «${page.title}»` : ''}`, source: 'link', ordinal: null });
    }
    for (const doc of documents) {
      await readText({ text: doc.text, label: `документ «${doc.name}»`, source: 'document', ordinal: doc.ordinal });
    }
    for (const img of images) {
      const prompt = `Скриншот ${img.ordinal} из ${images.length}. Заполни JSON по тексту на изображении.`;
      const part = await extractOne(prompt, [img.buffer.toString('base64')], 'screenshot', img.ordinal);
      if (part) parts.push(part);
      else failed += 1;
    }

    if (!parts.length) {
      throw new RecognitionError('Модель не вернула разборчивый ответ. Попробуйте ещё раз или заполните карточку вручную.');
    }
    if (failed) warnings.push(`Не удалось разобрать материалов: ${failed}. Остальное распознано.`);
    const merged = mergeExtractions(parts);
    merged.warnings = warnings;
    return merged;
  }

  recognize.configured = true;
  recognize.status = status;
  recognize.model = model;
  return recognize;
}
