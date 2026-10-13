// extension.js — Нативная интеграция Context Monitor в Status Bar Antigravity IDE
// Выводит живые показатели токенов, погоду контекста и обратный отсчет до авто-сжатия прямо в строку состояния

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

let statusBarItem;
let pollTimer = null;

// Поиск самой последней активной сессии в хранилище brain
function getLatestConversation() {
  try {
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    if (!fs.existsSync(brainDir)) return null;

    const entries = fs.readdirSync(brainDir, { withFileTypes: true });
    let latest = null;
    let maxMtime = 0;

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'tempmediaStorage') {
        const transcriptPath = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(transcriptPath)) {
          const stat = fs.statSync(transcriptPath);
          if (stat.mtimeMs > maxMtime) {
            maxMtime = stat.mtimeMs;
            latest = { id: entry.name, transcriptPath };
          }
        }
      }
    }
    return latest;
  } catch {
    return null;
  }
}

// Загрузка настроек виджета (пресет модели)
function loadSettings() {
  try {
    const settingsPath = path.join(
      os.homedir(),
      '.gemini',
      'antigravity',
      'sidecar_data',
      'context-monitor',
      'panel',
      'data',
      'settings.json'
    );
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch {}
  return { modelPreset: 'auto' };
}

// Форматирование чисел токенов
function formatTokens(count) {
  if (count === null || count === undefined || isNaN(count)) return '0';
  if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
  if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
  return count.toLocaleString('ru-RU');
}

// Парсинг лога диалога для получения токенов, модели и действий
function analyzeTranscript(transcriptPath) {
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.trim() ? raw.trim().split('\n') : [];
    if (lines.length === 0) return null;

    let lastTokens = null;
    let detectedModel = null;
    const toolStats = { total: 0, view: 0, cmd: 0, edit: 0 };

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

    return { lastTokens, detectedModel, toolStats, stepCount: lines.length };
  } catch {
    return null;
  }
}

// Форматирование слова "шаг/шага/шагов"
function formatStepsWord(steps) {
  const c = Math.abs(steps) % 100;
  const n = c % 10;
  if (c > 10 && c < 20) return 'шагов';
  if (n === 1) return 'шаг';
  if (n > 1 && n < 5) return 'шага';
  return 'шагов';
}

// Обновление состояния элемента строки состояния
function updateStatusBar() {
  if (!statusBarItem) return;

  try {
    const conv = getLatestConversation();
    if (!conv) {
      statusBarItem.text = '$(cloud) Token Weather: нет сессии';
      statusBarItem.tooltip = 'Активный диалог Antigravity пока не запущен';
      statusBarItem.show();
      return;
    }

    const analysis = analyzeTranscript(conv.transcriptPath);
    if (!analysis || !analysis.lastTokens) {
      statusBarItem.text = '$(cloud) 0k (0%)';
      statusBarItem.tooltip = 'Сессия запущена, ожидание первых токенов…';
      statusBarItem.show();
      return;
    }

    const settings = loadSettings();
    let effectivePreset = settings.modelPreset || 'auto';
    if (effectivePreset === 'auto') {
      effectivePreset = analysis.detectedModel || 'gemini';
    }

    const isClaude = effectivePreset === 'claude';
    const limit = isClaude ? 200000 : 1000000;
    const threshold = isClaude ? 160000 : 250000;
    const thresholdLabel = isClaude ? '160k' : '250k';

    const inputTokens = analysis.lastTokens.input_tokens || 0;
    const cacheTokens = analysis.lastTokens.cache_read_tokens || 0;
    const outputTokens = analysis.lastTokens.output_tokens || 0;
    const totalContext = inputTokens + cacheTokens;
    const cachePercent = totalContext > 0 ? Math.round((cacheTokens / totalContext) * 100) : 0;
    const percent = Math.min(100, Math.round((totalContext / limit) * 100));

    const remaining = Math.max(0, threshold - totalContext);
    const steps = Math.max(1, Math.round(remaining / 8000));
    const isImminent = remaining <= 25000;

    // Иконка и цвет для статусной строки
    let weatherIcon = '$(cloud)';
    let stepsText = `~${steps} ${formatStepsWord(steps)}`;

    if (percent >= 70 || remaining === 0) {
      weatherIcon = '$(flame)';
      statusBarItem.color = new vscode.ThemeColor('errorForeground');
    } else if (percent >= 40 || isImminent) {
      weatherIcon = '$(warning)';
      statusBarItem.color = new vscode.ThemeColor('editorWarning.foreground');
    } else {
      weatherIcon = '$(cloud)';
      statusBarItem.color = undefined;
    }

    let countdownLabel = remaining === 0 ? '⚠️ сжатие!' : `⚡ ~${stepsText}`;
    statusBarItem.text = `${weatherIcon} ${formatTokens(totalContext)}/${thresholdLabel} (${percent}%) | ${countdownLabel}`;

    // Всплывающая подсказка с подробной телеметрией
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`### 🌤️ Context Monitor (Token Weather)\n\n`);
    md.appendMarkdown(`- **Модель:** ${isClaude ? 'Claude (200k)' : 'Gemini (1.0M)'} ${settings.modelPreset === 'auto' ? '*(Авто)*' : ''}\n`);
    md.appendMarkdown(`- **Объем контекста:** **${formatTokens(totalContext)}** / ${formatTokens(limit)} токенов (**${percent}%**)\n`);
    md.appendMarkdown(`- **Порог авто-сжатия Antigravity:** ~${thresholdLabel} токенов\n`);

    if (remaining === 0) {
      md.appendMarkdown(`- **Прогноз:** ⚠️ **Порог превышен!** Antigravity автоматически сожмет контекст.\n\n`);
    } else if (isImminent) {
      md.appendMarkdown(`- **Прогноз:** ⚠️ Осталось **~${formatTokens(remaining)}** токенов (**${stepsText}**). Рекомендуется Safe Handoff!\n\n`);
    } else {
      md.appendMarkdown(`- **Прогноз:** До сжатия сессии осталось **~${formatTokens(remaining)}** токенов (**${stepsText}**).\n\n`);
    }

    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`📥 Вход: **${formatTokens(inputTokens)}**  |  ⚡ Кэш: **${formatTokens(cacheTokens)}** (${cachePercent}%)  |  📤 Ответ: **${formatTokens(outputTokens)}**\n\n`);
    md.appendMarkdown(`🛠️ **Действия агента:** всего **${analysis.toolStats.total}** (👁️ ${analysis.toolStats.view} чтений • ⚡ ${analysis.toolStats.cmd} команд • ✏️ ${analysis.toolStats.edit} правок)\n\n`);
    md.appendMarkdown(`*Нажмите, чтобы открыть или скрыть боковую панель Context Monitor*`);

    statusBarItem.tooltip = md;
    statusBarItem.show();
  } catch (err) {
    if (statusBarItem) {
      statusBarItem.text = '$(cloud) Context Monitor';
      statusBarItem.show();
    }
  }
}

function activate(context) {
  // Приоритет 1000 гарантирует показ без вытеснения в меню переполнения
  statusBarItem = vscode.window.createStatusBarItem('contextMonitor.status', vscode.StatusBarAlignment.Right, 1000);
  statusBarItem.name = 'Context Monitor';
  statusBarItem.text = '$(cloud) Context Monitor';
  statusBarItem.tooltip = 'Context Monitor (Token Weather): запуск…';
  statusBarItem.command = 'contextMonitor.togglePanel';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const toggleCmd = vscode.commands.registerCommand('contextMonitor.togglePanel', () => {
    vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
  });
  context.subscriptions.push(toggleCmd);

  const refreshCmd = vscode.commands.registerCommand('contextMonitor.refresh', () => {
    updateStatusBar();
    vscode.window.showInformationMessage('Context Monitor: статус обновлен');
  });
  context.subscriptions.push(refreshCmd);

  // Команда быстрого восстановления десктопного HUD после обновлений Antigravity
  const patchCmd = vscode.commands.registerCommand('contextMonitor.patchApp', () => {
    const patchScript = path.join(__dirname, 'scripts', 'patch-antigravity.js');
    if (!fs.existsSync(patchScript)) {
      vscode.window.showErrorMessage('Context Monitor: скрипт patch-antigravity.js не найден');
      return;
    }
    const { exec } = require('child_process');
    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Context Monitor: Восстановление Mini-HUD в Antigravity...',
      cancellable: false
    }, () => {
      return new Promise((resolve) => {
        exec(`node "${patchScript}"`, (err) => {
          if (err) {
            vscode.window.showErrorMessage('Ошибка применения патча: ' + err.message);
          } else {
            vscode.window.showInformationMessage('✅ Mini-HUD успешно восстановлен! Нажмите Ctrl+R в окне Antigravity.');
          }
          resolve();
        });
      });
    });
  });
  context.subscriptions.push(patchCmd);

  // Проверка: слетел ли патч после авто-обновления Antigravity
  setTimeout(() => {
    try {
      const home = os.homedir();
      let asarPath = '';
      if (process.platform === 'win32') {
        asarPath = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Antigravity', 'resources', 'app.asar');
      } else if (process.platform === 'darwin') {
        asarPath = '/Applications/Antigravity.app/Contents/Resources/app.asar';
      } else {
        asarPath = '/opt/Antigravity/resources/app.asar';
      }
      if (fs.existsSync(asarPath)) {
        const raw = fs.readFileSync(asarPath, 'utf8');
        if (!raw.includes('initContextHud')) {
          vscode.window.showWarningMessage(
            '⚡ Context Monitor: Antigravity обновился, десктопный Mini-HUD был сброшен к заводской версии.',
            'Восстановить в 1 клик'
          ).then((sel) => {
            if (sel === 'Восстановить в 1 клик') {
              vscode.commands.executeCommand('contextMonitor.patchApp');
            }
          });
        }
      }
    } catch {}
  }, 3000);

  updateStatusBar();
  pollTimer = setInterval(updateStatusBar, 3500);
}

function deactivate() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  activate,
  deactivate
};
