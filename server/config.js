import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Подхватываем .env (если есть). Переменные окружения, заданные снаружи, имеют приоритет.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* .env не обязателен */
}

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  return {
    port: Number(env.PORT) || 3000,
    // Входа в приложении нет, поэтому по умолчанию оно доступно только с этого компьютера.
    host: env.HOST || '127.0.0.1',
    allowedHosts: String(env.ALLOWED_HOSTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    dataDir,
    dbPath: env.DB_PATH ? path.resolve(env.DB_PATH) : path.join(dataDir, 'tenders.db'),
    uploadsDir: path.join(dataDir, 'uploads'),
    ollamaUrl: (env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    ollamaModel: env.OLLAMA_MODEL || 'qwen2.5vl:7b',
    ollamaNumCtx: Number(env.OLLAMA_NUM_CTX) || 16384,
    // Сколько фрагментов (по ~6000 знаков) читать из одного длинного документа или страницы.
    ollamaMaxChunks: Number(env.OLLAMA_MAX_CHUNKS) || 10,
    // Только для тестов: разрешает загрузку страниц с локальных адресов.
    allowPrivateFetch: env.ALLOW_PRIVATE_FETCH === '1',
  };
}
