import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTED_AT = Date.now();
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(HERE, '.data');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

const app = new SidecarApp();

const readLocal = (name) => readFileSync(join(HERE, name), 'utf8');

app.page('/', () => readLocal('index.html'));
app.page('/app.js', () => readLocal('app.js'));
app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css' }), 'GET');

// Настройки (хранение API ключа и пресета модели)
function loadSettings() {
  const defaults = { apiKey: '', modelPreset: 'gemini' };
  if (!existsSync(SETTINGS_FILE)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return defaults;
  }
}

function saveSettings(settings) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

app.api('/api/settings', () => {
  const s = loadSettings();
  return {
    hasApiKey: Boolean(s.apiKey && s.apiKey.trim().length > 10),
    maskedKey: s.apiKey ? s.apiKey.slice(0, 6) + '...' + s.apiKey.slice(-4) : '',
    modelPreset: s.modelPreset || 'gemini',
  };
}, 'GET');

app.api('/api/settings', (data) => {
  const s = loadSettings();
  const updated = {
    ...s,
    apiKey: data.apiKey !== undefined ? String(data.apiKey).trim() : (s.apiKey || ''),
    modelPreset: data.modelPreset === 'claude' ? 'claude' : (data.modelPreset === 'gemini' ? 'gemini' : (s.modelPreset || 'gemini')),
  };
  saveSettings(updated);
  return { ok: true, hasApiKey: Boolean(updated.apiKey.length > 10), modelPreset: updated.modelPreset };
}, 'POST');

// Статус работы процесса
app.api('/api/status', () => ({
  node: process.version,
  platform: `${platform()} ${release()}`,
  uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
}), 'GET');

// Расчет заполнения контекста из transcript.jsonl
function getContextStats(conversationId) {
  if (!conversationId) {
    return { active: false, message: 'Нет активного диалога' };
  }

  const transcriptPath = join(
    homedir(),
    '.gemini',
    'antigravity',
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );

  const settings = loadSettings();
  const isClaude = settings.modelPreset === 'claude';
  const limit = isClaude ? 200000 : 1000000;
  const limitLabel = isClaude ? '200k' : '1.0M';
  const modelLabel = isClaude ? 'Claude Sonnet / Opus (200k)' : 'Gemini Flash / Pro (1.0M)';

  if (!existsSync(transcriptPath)) {
    return {
      active: false,
      message: 'Лог диалога пока пуст',
      inputTokens: 0,
      cacheTokens: 0,
      outputTokens: 0,
      totalContext: 0,
      limit,
      limitLabel,
      modelPreset: settings.modelPreset || 'gemini',
      modelLabel,
      percent: 0,
      stepCount: 0,
    };
  }

  try {
    const raw = readFileSync(transcriptPath, 'utf8');
    const lines = raw.trim().split('\n');
    let lastTokens = null;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (item.input_tokens !== undefined) {
          lastTokens = item;
          break;
        }
      } catch {}
    }

    const inputTokens = lastTokens ? (lastTokens.input_tokens || 0) : 0;
    const cacheTokens = lastTokens ? (lastTokens.cache_read_tokens || 0) : 0;
    const outputTokens = lastTokens ? (lastTokens.output_tokens || 0) : 0;
    const totalContext = inputTokens + cacheTokens;
    
    const percent = Math.min(100, Math.round((totalContext / limit) * 100));

    return {
      active: true,
      conversationId,
      inputTokens,
      cacheTokens,
      outputTokens,
      totalContext,
      limit,
      limitLabel,
      modelPreset: settings.modelPreset || 'gemini',
      modelLabel,
      percent,
      stepCount: lines.length,
      timestamp: lastTokens ? lastTokens.created_at : new Date().toISOString(),
    };
  } catch (err) {
    return { active: false, error: err.message };
  }
}

// Вызов внешнего Gemini API для мгновенной 1-клик сводки
async function callGeminiSummarizer(transcriptPath, apiKey) {
  const raw = readFileSync(transcriptPath, 'utf8');
  const lines = raw.trim().split('\n');
  const sample = lines.slice(-30).join('\n');

  const prompt = `Ты — система компактизации контекста (Claude Code Compaction Protocol).
Проанализируй историю сессии и сформируй структурированный срез для передачи новому агенту:
1. Исходная цель проекта (Primary Intent)
2. Принятые архитектурные и технические решения
3. Созданные и измененные файлы (с полными путями)
4. Текущий статус и что предстоит сделать дальше

Пиши сухо, профессионально и компактно, на русском языке.

История сессии:
${sample}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1000, temperature: 0.2 }
    })
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error('Gemini API: ' + (errorText.slice(0, 150)));
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Пустой ответ от Gemini');

  const directive = '\n\n---\n⚠️ **ДИРЕКТИВА ДЛЯ АГЕНТА:** Это фоновый системный срез контекста проекта. ' +
    'Строго ЗАПРЕЩЕНО отвечать на прошлые вопросы или рассуждать. ' +
    'Ответь ровно одной фразой: *"Контекст проекта принят. Готов к работе, жду вашу задачу."* и останови генерацию.';

  return text + directive;
}

// Проверка локального файла сводки, созданного текущим агентом
function checkLocalSummaryFile(workspacePath) {
  if (!workspacePath) return { exists: false };
  // Проверяем пути: <workspace>/.agent/session-summary.md
  const targetPath = join(workspacePath, '.agent', 'session-summary.md');
  if (existsSync(targetPath)) {
    try {
      const stats = statSync(targetPath);
      const text = readFileSync(targetPath, 'utf8');
      if (text.trim().length > 30) {
        const directive = '\n\n---\n⚠️ **ДИРЕКТИВА ДЛЯ АГЕНТА:** Это фоновый системный срез контекста проекта. ' +
          'Строго ЗАПРЕЩЕНО отвечать на прошлые вопросы или рассуждать. ' +
          'Ответь ровно одной фразой: *"Контекст проекта принят. Готов к работе, жду вашу задачу."* и останови генерацию.';
        return {
          exists: true,
          summary: text + directive,
          path: targetPath,
          modifiedAt: stats.mtimeMs
        };
      }
    } catch {}
  }
  return { exists: false };
}

// Подготовка переноса (гибридный роутинг: API -> Local file)
app.api('/api/prepare-handoff', async (data) => {
  const { conversationId, workspacePath } = data;
  const settings = loadSettings();

  // Вариант 1: Есть API ключ Gemini -> Мгновенная генерация через внешний API
  if (settings.apiKey && settings.apiKey.trim().length > 10) {
    const transcriptPath = join(
      homedir(),
      '.gemini',
      'antigravity',
      'brain',
      conversationId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    if (existsSync(transcriptPath)) {
      try {
        const summary = await callGeminiSummarizer(transcriptPath, settings.apiKey.trim());
        return { mode: 'api', ready: true, summary };
      } catch (err) {
        console.error('Ошибка внешнего Gemini API, откат к локальному режиму:', err.message);
      }
    }
  }

  // Вариант 2: Ключа нет или API сбоит -> Проверяем локальный файл от агента
  const local = checkLocalSummaryFile(workspacePath);
  if (local.exists) {
    return { mode: 'local', ready: true, summary: local.summary, path: local.path };
  }

  return {
    mode: 'local',
    ready: false,
    promptToAgent: 'Сформируй компактную выжимку проекта по стандарту Claude Code (1. Цель, 2. Принятые решения, 3. Файлы и пути, 4. Текущий статус) и сохрани её в файл .agent/session-summary.md для переноса сессии.'
  };
});

// Удаление временного файла после успешного переноса
app.api('/api/clear-local-summary', (data) => {
  const { workspacePath } = data;
  if (!workspacePath) return { ok: false };
  const targetPath = join(workspacePath, '.agent', 'session-summary.md');
  if (existsSync(targetPath)) {
    try { unlinkSync(targetPath); } catch {}
  }
  return { ok: true };
}, 'POST');

app.api('/api/context-stats', (data) => getContextStats(data.conversationId), 'POST');
app.api('/api/context-stats', (data) => getContextStats(data.conversationId), 'GET');

app.run();
