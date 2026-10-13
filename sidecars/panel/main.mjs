import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { Response, SidecarApp } from 'sidecar_sdk';

const execAsync = promisify(exec);
const HERE = dirname(fileURLToPath(import.meta.url));
const STARTED_AT = Date.now();
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(HERE, '.data');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

const app = new SidecarApp();

const readLocal = (name) => readFileSync(join(HERE, name), 'utf8');

function getAsarPath() {
  if (platform() === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'Antigravity', 'resources', 'app.asar');
  } else if (platform() === 'darwin') {
    return '/Applications/Antigravity.app/Contents/Resources/app.asar';
  }
  return '/opt/Antigravity/resources/app.asar';
}

function isHudPatched() {
  try {
    const asar = getAsarPath();
    if (!existsSync(asar)) return true;
    const raw = readFileSync(asar, 'utf8');
    return raw.includes('initContextHud');
  } catch {
    return true;
  }
}

async function runPatchScript() {
  const patchScript = join(dirname(dirname(HERE)), 'scripts', 'patch-antigravity.js');
  if (!existsSync(patchScript)) return false;
  try {
    await execAsync(`node "${patchScript}"`);
    return isHudPatched();
  } catch (err) {
    console.error('[Context Monitor Sidecar] Ошибка применения патча:', err);
    return false;
  }
}

// Автоматическая проверка и восстановление патча после обновлений Antigravity
setTimeout(async () => {
  const s = loadSettings();
  if (s.showHud !== false && !isHudPatched()) {
    console.log('[Context Monitor Sidecar] Обнаружено обновление Antigravity (патч сброшен). Авто-восстановление Mini-HUD...');
    await runPatchScript();
  }
}, 1500);

app.page('/', () => readLocal('index.html'));
app.page('/app.js', () => readLocal('app.js'));
app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css' }), 'GET');
app.api('/logo.svg', () => new Response(readLocal('logo.svg'), { contentType: 'image/svg+xml' }), 'GET');

// Настройки (хранение API ключа, пресета модели и видимости Mini-HUD)
function loadSettings() {
  const defaults = { apiKey: '', modelPreset: 'auto', showHud: true };
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
    modelPreset: s.modelPreset || 'auto',
    showHud: s.showHud !== false,
    isHudPatched: isHudPatched(),
  };
}, 'GET');

app.api('/api/patch-hud', async () => {
  const ok = await runPatchScript();
  return { ok, isHudPatched: isHudPatched() };
}, 'POST');

app.api('/api/settings', (data) => {
  const s = loadSettings();
  const validPreset = ['auto', 'gemini', 'claude'].includes(data.modelPreset) ? data.modelPreset : (s.modelPreset || 'auto');
  const updated = {
    ...s,
    apiKey: data.apiKey !== undefined ? String(data.apiKey).trim() : (s.apiKey || ''),
    modelPreset: validPreset,
    showHud: data.showHud !== undefined ? Boolean(data.showHud) : (s.showHud !== false),
  };
  saveSettings(updated);
  return { ok: true, hasApiKey: Boolean(updated.apiKey.length > 10), modelPreset: updated.modelPreset, showHud: updated.showHud };
}, 'POST');

// Статус работы процесса
app.api('/api/status', () => ({
  node: process.version,
  platform: `${platform()} ${release()}`,
  uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
}), 'GET');

function analyzeTranscript(lines) {
  let detectedModel = null;
  const toolStats = { total: 0, view: 0, cmd: 0, edit: 0 };
  let lastTokens = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const item = JSON.parse(lines[i]);
      if (!lastTokens && item.input_tokens !== undefined) {
        lastTokens = item;
      }
      if (!detectedModel) {
        const m = (item.model || item.model_name || item.planner_model || '').toLowerCase();
        if (m.includes('claude')) detectedModel = 'claude';
        else if (m.includes('gemini')) detectedModel = 'gemini';
      }
      if (Array.isArray(item.tool_calls)) {
        for (const tc of item.tool_calls) {
          toolStats.total++;
          const name = (tc.name || '').toLowerCase();
          if (name.includes('view') || name.includes('read') || name.includes('list') || name.includes('search')) {
            toolStats.view++;
          } else if (name.includes('command') || name.includes('terminal')) {
            toolStats.cmd++;
          } else if (name.includes('write') || name.includes('replace') || name.includes('edit')) {
            toolStats.edit++;
          }
        }
      }
    } catch {}
  }

  return { lastTokens, detectedModel, toolStats };
}

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
  const raw = existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : '';
  const lines = raw.trim() ? raw.trim().split('\n') : [];
  const { lastTokens, detectedModel, toolStats } = analyzeTranscript(lines);

  let effectivePreset = settings.modelPreset;
  if (!effectivePreset || effectivePreset === 'auto') {
    effectivePreset = detectedModel || 'gemini';
  }
  const isClaude = effectivePreset === 'claude';
  const limit = isClaude ? 200000 : 1000000;
  const limitLabel = isClaude ? '200k' : '1.0M';
  const modelLabel = isClaude ? 'Claude Sonnet / Opus (200k)' : 'Gemini Flash / Pro (1.0M)';

  if (lines.length === 0) {
    return {
      active: false,
      message: 'Лог диалога пока пуст',
      inputTokens: 0,
      cacheTokens: 0,
      outputTokens: 0,
      totalContext: 0,
      limit,
      limitLabel,
      modelPreset: settings.modelPreset || 'auto',
      effectivePreset,
      detectedModel: detectedModel || (isClaude ? 'claude' : 'gemini'),
      modelLabel,
      percent: 0,
      compactThreshold: isClaude ? 160000 : 250000,
      compactThresholdPercent: isClaude ? 80 : 25,
      compactThresholdLabel: isClaude ? '160k' : '250k',
      remainingToCompact: isClaude ? 160000 : 250000,
      stepsToCompact: Math.round((isClaude ? 160000 : 250000) / 8000),
      burnRate: 8000,
      isCompactImminent: false,
      toolStats,
      cacheEfficiency: 0,
      timestamp: new Date().toISOString(),
    };
  }

  try {
    const inputTokens = lastTokens ? (lastTokens.input_tokens || 0) : 0;
    const cacheTokens = lastTokens ? (lastTokens.cache_read_tokens || 0) : 0;
    const outputTokens = lastTokens ? (lastTokens.output_tokens || 0) : 0;
    const totalContext = inputTokens + cacheTokens;
    const cacheEfficiency = totalContext > 0 ? Math.round((cacheTokens / totalContext) * 100) : 0;
    
    const percent = Math.min(100, Math.round((totalContext / limit) * 100));

    // Прогнозирование момента Auto-compaction в Antigravity
    // Порог: для Claude 200k — ~160k (80%), для Gemini 1.0M — ~250k (25%)
    const compactThreshold = isClaude ? 160000 : 250000;
    const compactThresholdPercent = Math.round((compactThreshold / limit) * 100);
    const compactThresholdLabel = isClaude ? '160k' : '250k';

    // Расчет среднего расхода за шаг (Burn Rate) по недавней истории
    let burnRate = 8000;
    const recentTotals = [];
    for (let i = lines.length - 1; i >= 0 && recentTotals.length < 6; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (item.input_tokens !== undefined) {
          recentTotals.push((item.input_tokens || 0) + (item.cache_read_tokens || 0));
        }
      } catch {}
    }
    if (recentTotals.length >= 2) {
      const deltas = [];
      for (let j = 0; j < recentTotals.length - 1; j++) {
        const delta = recentTotals[j] - recentTotals[j + 1];
        if (delta > 500 && delta < 60000) deltas.push(delta);
      }
      if (deltas.length > 0) {
        burnRate = Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length);
      }
    }

    const remainingToCompact = Math.max(0, compactThreshold - totalContext);
    const stepsToCompact = remainingToCompact === 0 ? 0 : Math.max(1, Math.round(remainingToCompact / burnRate));
    const isCompactImminent = remainingToCompact <= 25000;

    return {
      active: true,
      conversationId,
      inputTokens,
      cacheTokens,
      outputTokens,
      totalContext,
      limit,
      limitLabel,
      modelPreset: settings.modelPreset || 'auto',
      effectivePreset,
      detectedModel: detectedModel || (isClaude ? 'claude' : 'gemini'),
      modelLabel,
      percent,
      stepCount: lines.length,
      compactThreshold,
      compactThresholdPercent,
      compactThresholdLabel,
      remainingToCompact,
      stepsToCompact,
      burnRate,
      isCompactImminent,
      toolStats,
      cacheEfficiency,
      showHud: settings.showHud !== false,
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
Не используй markdown-мишуру (без ##, без **, без ---). Используй чистый простой текст со списками через дефис.

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

  const directive = '\n\nИнструкция: Это фоновый срез контекста проекта. Не отвечай на прошлые вопросы и не рассуждай. Ответь одной короткой фразой: "Контекст проекта принят. Готов к работе, жду задачу." и останови ответ.';

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
        const directive = '\n\nИнструкция: Это фоновый срез контекста проекта. Не отвечай на прошлые вопросы и не рассуждай. Ответь одной короткой фразой: "Контекст проекта принят. Готов к работе, жду задачу." и останови ответ.';
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
const handlePrepareHandoff = async (data) => {
  const { conversationId, workspacePath } = data || {};
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
    promptToAgent: 'Сформируй компактную выжимку проекта по стандарту Claude Code (1. Цель, 2. Принятые решения, 3. Файлы и пути, 4. Текущий статус) чистым текстом без markdown-мишуры (без ##, без **, без ---) и сохрани её в файл .agent/session-summary.md для переноса сессии.'
  };
};

app.api('/api/prepare-handoff', handlePrepareHandoff, 'POST');
app.api('/api/prepare-handoff', handlePrepareHandoff, 'GET');
app.api('/api/handoff', handlePrepareHandoff, 'POST');
app.api('/api/handoff', handlePrepareHandoff, 'GET');

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
