// Демо-запуск для проверки интерфейса БЕЗ Ollama.
// «Распознавание» здесь фиктивное (заготовки из примера задания); в работе используется локальная модель Ollama.
//   npm run demo   →  http://localhost:3100
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { normalizeExtraction } from '../server/extract.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-demo-'));
const config = loadConfig({ DATA_DIR: dataDir, PORT: process.env.PORT || '3100', HOST: '127.0.0.1' });
const db = openDb(path.join(dataDir, 'demo.db'));

const recognizer = Object.assign(
  async ({ page, images, documents = [] }) => {
    await new Promise((r) => setTimeout(r, 600));
    if (documents.length) {
      return normalizeExtraction({
        company: 'ООО «Компания В»', title: 'Поставка датчиков давления', type: 'ЗЦП', number: 'ЗЦП-2026-9',
        deadline_raw: '05.03.2027 12:00 (МСК)', deadline_date: '2027-03-05', deadline_time: '12:00', deadline_timezone: 'МСК',
        requirements_visible: true,
        checklist: [
          { title: 'Приложить ценовое предложение', required: 'yes', source: 'document', ordinal: 1, excerpt: 'Price offer and equipment passport must be attached' },
          { title: 'Приложить паспорт оборудования', required: 'yes', source: 'document', ordinal: documents.length, excerpt: 'equipment passport' },
        ],
      });
    }
    if (page?.text) {
      return normalizeExtraction({
        company: 'ООО «Компания А»', title: 'Поставка датчиков вибрации', type: 'Тендер', number: '0123-45',
        deadline_raw: '15.12.2026 17:00 МСК', deadline_date: '2026-12-15', deadline_time: '17:00', deadline_timezone: 'МСК',
        requirements_visible: true,
        checklist: [
          { title: 'Приложить ценовое предложение', required: 'yes', source: 'link', screenshot_number: null, excerpt: 'К заявке необходимо приложить ценовое предложение' },
          { title: 'Приложить копию свидетельства о поверке', required: 'unclear', source: 'link', screenshot_number: null, excerpt: 'Желательно предоставить копию свидетельства о поверке' },
        ],
      });
    }
    if (images.length >= 2) {
      return normalizeExtraction({
        company: 'ООО «Компания Б»', title: 'Поставка преобразователей напряжения 24 В → 12 В', type: 'ЗЦП', number: 'Лот № 77',
        deadline_raw: '20.12.2026 до 1', deadline_date: '2026-12-20', deadline_time: '', deadline_review: 'Время обрезано на скриншоте',
        requirements_visible: true,
        checklist: [
          { title: 'Приложить ценовое предложение', required: 'yes', source: 'screenshot', screenshot_number: 2, excerpt: 'К заявке необходимо приложить ценовое предложение' },
          { title: 'Приложить паспорт оборудования', required: 'yes', source: 'screenshot', screenshot_number: 2, excerpt: 'и паспорт оборудования' },
        ],
      });
    }
    return normalizeExtraction({
      company: 'ООО «Компания Б»', title: 'Поставка преобразователей напряжения 24 В → 12 В', type: 'ЗЦП', number: 'Лот № 77',
      deadline_raw: '20.12.2026', deadline_date: '2026-12-20', deadline_time: '12:00', requirements_visible: false, checklist: [],
    });
  },
  { configured: true, status: async () => ({ ok: true, message: '' }), model: 'демо (фиктивное распознавание)' },
);

createApp({ db, config, recognizer }).listen(config.port, config.host, () => {
  console.log(`ДЕМО (фиктивное распознавание): http://localhost:${config.port}`);
});
