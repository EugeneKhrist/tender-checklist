import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { createOllamaRecognizer } from './ollama.js';

async function main() {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const recognizer = createOllamaRecognizer({
    baseUrl: config.ollamaUrl,
    model: config.ollamaModel,
    numCtx: config.ollamaNumCtx,
  });

  const app = createApp({ db, config, recognizer });
  app.listen(config.port, config.host, async () => {
    console.log(`Чек-лист тендеров запущен: http://localhost:${config.port}`);
    console.log(`База данных: ${config.dbPath}`);
    const st = await recognizer.status();
    console.log(st.ok ? `Распознавание: Ollama, модель ${config.ollamaModel}` : `Распознавание недоступно: ${st.message}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
