#!/usr/bin/env node
/**
 * Скрипт автоматического внедрения плавающего HUD-индикатора контекста в десктопное приложение Antigravity
 * Поддерживает Windows, macOS и Linux.
 * Создает резервную копию app.asar.bak перед внесением любых изменений.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Определение путей к ресурсам Antigravity в зависимости от ОС
function getAsarPaths() {
  const home = os.homedir();
  let defaultAsar = '';

  if (process.platform === 'win32') {
    defaultAsar = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Antigravity', 'resources', 'app.asar');
  } else if (process.platform === 'darwin') {
    defaultAsar = '/Applications/Antigravity.app/Contents/Resources/app.asar';
  } else {
    defaultAsar = '/opt/Antigravity/resources/app.asar';
  }

  return {
    asarPath: defaultAsar,
    bakPath: defaultAsar + '.bak',
    resDir: path.dirname(defaultAsar)
  };
}

// Код IPC-обработчика для dist/ipcHandlers.js
const IPC_HANDLER_SNIPPET = `
    // [Context Monitor] Обработчик телеметрии контекста и расчета шагов до сжатия
    electron_1.ipcMain.handle('antigravity:get-context-telemetry', async () => {
        try {
            const fs = require('fs');
            const path = require('path');
            const os = require('os');

            // Проверка: включен ли плагин context-monitor пользователем
            const configPath = path.join(os.homedir(), '.gemini', 'config', 'config.json');
            const pluginDir = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'context-monitor');
            if (!fs.existsSync(pluginDir)) return null;
            if (fs.existsSync(configPath)) {
                try {
                    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    if (cfg && cfg.plugins && cfg.plugins['context-monitor']) {
                        if (cfg.plugins['context-monitor'].enabled === false) {
                            return null;
                        }
                    }
                } catch {}
            }

            // Проверка настройки видимости Mini-HUD из боковой панели плагина
            const settingsPath = path.join(os.homedir(), '.gemini', 'antigravity', 'sidecar_data', 'context-monitor', 'panel', 'data', 'settings.json');
            if (fs.existsSync(settingsPath)) {
                try {
                    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                    if (s && s.showHud === false) {
                        return null; // Пользователь скрыл Mini-HUD в настройках панели
                    }
                } catch {}
            }

            const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
            if (!fs.existsSync(brainDir)) return null;

            const entries = fs.readdirSync(brainDir, { withFileTypes: true });
            let latestDir = null;
            let latestMtime = 0;
            let latestLogPath = null;

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const logPath = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
                    try {
                        const stat = fs.statSync(logPath);
                        if (stat.mtimeMs > latestMtime) {
                            latestMtime = stat.mtimeMs;
                            latestDir = entry.name;
                            latestLogPath = logPath;
                        }
                    } catch {}
                }
            }

            if (!latestLogPath) return null;

            // Читаем последние 128 КБ лога для максимальной производительности
            const fd = fs.openSync(latestLogPath, 'r');
            const stat = fs.fstatSync(fd);
            const readSize = Math.min(stat.size, 131072);
            const buffer = Buffer.alloc(readSize);
            fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
            fs.closeSync(fd);

            const text = buffer.toString('utf8');
            const lines = text.trim().split('\\n');

            const history = [];
            for (let i = lines.length - 1; i >= 0 && history.length < 6; i--) {
                try {
                    const row = JSON.parse(lines[i]);
                    if (row.input_tokens !== undefined) {
                        history.push({
                            step: row.step_index,
                            input: row.input_tokens || 0,
                            cache: row.cache_read_tokens || 0,
                            output: row.output_tokens || 0,
                            total: (row.input_tokens || 0) + (row.cache_read_tokens || 0)
                        });
                    }
                } catch {}
            }

            if (history.length === 0) return null;
            const current = history[0];

            // Расчет среднего расхода токенов на шаг
            let avgDelta = 3500;
            if (history.length >= 2) {
                const deltas = [];
                for (let i = 0; i < history.length - 1; i++) {
                    const diff = history[i].total - history[i + 1].total;
                    if (diff > 0 && diff < 30000) deltas.push(diff);
                }
                if (deltas.length > 0) {
                    avgDelta = Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length);
                }
            }

            // Автоопределение модели (Claude 200k / Gemini 1.0M)
            let isClaude = false;
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const row = JSON.parse(lines[i]);
                    const m = (row.model || row.model_name || row.planner_model || '').toLowerCase();
                    if (m.includes('claude')) { isClaude = true; break; }
                    if (m.includes('gemini')) { isClaude = false; break; }
                } catch {}
            }

            // Порог авто-сжатия Antigravity: 250k для Gemini, 160k для Claude
            const COMPACT_THRESHOLD = isClaude ? 160000 : 250000;
            const MAX_BUDGET = isClaude ? 200000 : 1000000;
            const remaining = Math.max(0, COMPACT_THRESHOLD - current.total);
            const stepsRemaining = avgDelta > 0 ? Math.max(0, Math.floor(remaining / avgDelta)) : 0;
            const compactPercent = Math.min(100, Math.round((current.total / COMPACT_THRESHOLD) * 100));
            const totalPercent = Math.min(100, Math.round((current.total / MAX_BUDGET) * 100));

            return {
                conversationId: latestDir,
                isClaude,
                currentStep: current.step,
                inputTokens: current.input,
                cacheTokens: current.cache,
                outputTokens: current.output,
                totalTokens: current.total,
                compactThreshold: COMPACT_THRESHOLD,
                maxBudget: MAX_BUDGET,
                remainingTokens: remaining,
                compactPercent,
                totalPercent,
                avgDelta,
                stepsRemaining,
                needsCompaction: current.total >= COMPACT_THRESHOLD
            };
        } catch (err) {
            return null;
        }
    });

    // [Context Monitor] Обработчик переключения видимости плавающего HUD из окна
    electron_1.ipcMain.handle('antigravity:toggle-context-hud', async (_event, show) => {
        try {
            const fs = require('fs');
            const path = require('path');
            const os = require('os');
            const settingsDir = path.join(os.homedir(), '.gemini', 'antigravity', 'sidecar_data', 'context-monitor', 'panel', 'data');
            const settingsPath = path.join(settingsDir, 'settings.json');
            if (!fs.existsSync(settingsDir)) {
                fs.mkdirSync(settingsDir, { recursive: true });
            }
            let settings = {};
            if (fs.existsSync(settingsPath)) {
                try {
                    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
                } catch {}
            }
            settings.showHud = Boolean(show);
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
            return { ok: true, showHud: settings.showHud };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });
`;

// Код плавающего индикатора для dist/preload.js
const PRELOAD_HUD_SNIPPET = `
// [Context Monitor] Модуль плавающего индикатора контекста в окне приложения
(function initContextHud() {
    if (typeof window === 'undefined') return;

    let isExpanded = false;
    let isMinimized = false;

    function formatNumber(num) {
        if (!num) return '0';
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
        return String(num);
    }

    function getStepWord(n) {
        const abs = Math.abs(n) % 100;
        const last = abs % 10;
        if (abs > 10 && abs < 20) return 'шагов';
        if (last > 1 && last < 5) return 'шага';
        if (last === 1) return 'шаг';
        return 'шагов';
    }

    function ensureHudElement() {
        if (!document.body || document.getElementById('ag-context-hud')) return;

        const container = document.createElement('div');
        container.id = 'ag-context-hud';
        container.style.cssText = \`
            position: fixed;
            bottom: 16px;
            left: 280px;
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 11.5px;
            font-weight: 500;
            user-select: none;
            -webkit-user-select: none;
            box-sizing: border-box;
            line-height: 1.4;
            letter-spacing: -0.01em;
            pointer-events: auto;
        \`;

        try {
            const saved = localStorage.getItem('ag_hud_pos');
            if (saved) {
                const pos = JSON.parse(saved);
                if (pos.left !== undefined && pos.top !== undefined) {
                    container.style.bottom = 'auto';
                    container.style.left = Math.max(10, Math.min(window.innerWidth - 80, pos.left)) + 'px';
                    container.style.top = Math.max(10, Math.min(window.innerHeight - 40, pos.top)) + 'px';
                }
            }
        } catch {}

        container.innerHTML = \`
            <div id="ag-hud-card" style="
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 6px 14px;
                background: rgba(15, 23, 42, 0.88);
                backdrop-filter: blur(14px);
                -webkit-backdrop-filter: blur(14px);
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 999px;
                color: #e2e8f0;
                box-shadow: 0 8px 24px -4px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.04);
                cursor: grab;
                transition: border-color 0.2s ease, box-shadow 0.2s ease;
            ">
                <span id="ag-hud-dot" style="
                    width: 7px;
                    height: 7px;
                    border-radius: 50%;
                    background: #38bdf8;
                    box-shadow: 0 0 8px #38bdf8;
                    flex-shrink: 0;
                "></span>
                <span id="ag-hud-label" style="display: flex; align-items: center; gap: 6px;">
                    <span style="opacity: 0.7;">Контекст:</span>
                    <span id="ag-hud-tokens" style="font-weight: 600; color: #f8fafc;">Загрузка...</span>
                </span>
                <div id="ag-hud-actions" style="display: flex; align-items: center; gap: 4px; margin-left: 2px;">
                    <button id="ag-hud-btn-info" title="Детализация токенов" style="
                        background: none; border: none; padding: 2px; color: #94a3b8; cursor: pointer; display: flex; align-items: center; outline: none; border-radius: 4px;
                    ">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                    </button>
                    <button id="ag-hud-btn-min" title="Свернуть виджет" style="
                        background: none; border: none; padding: 2px; color: #94a3b8; cursor: pointer; display: flex; align-items: center; outline: none; border-radius: 4px;
                    ">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg>
                    </button>
                    <button id="ag-hud-btn-close" title="Скрыть индикатор (включить можно в панели плагина)" style="
                        background: none; border: none; padding: 2px; color: #94a3b8; cursor: pointer; display: flex; align-items: center; outline: none; border-radius: 4px;
                    ">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>
            </div>

            <div id="ag-hud-popover" style="
                display: none;
                margin-top: 8px;
                padding: 12px 14px;
                background: rgba(15, 23, 42, 0.94);
                backdrop-filter: blur(16px);
                -webkit-backdrop-filter: blur(16px);
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 12px;
                box-shadow: 0 16px 36px -6px rgba(0, 0, 0, 0.6);
                width: 260px;
                color: #cbd5e1;
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px;">
                    <span style="font-weight: 600; color: #f1f5f9;">Телеметрия контекста</span>
                    <span id="ag-pop-step" style="font-size: 10px; color: #64748b;">Шаг #0</span>
                </div>
                <div style="display: grid; grid-template-columns: 1fr auto; gap: 4px; font-size: 11px;">
                    <span style="color: #94a3b8;">Входные токены:</span>
                    <span id="ag-pop-in" style="font-weight: 500; color: #f8fafc;">-</span>
                    <span style="color: #94a3b8;">Кэшированные токены:</span>
                    <span id="ag-pop-cache" style="font-weight: 500; color: #f8fafc;">-</span>
                    <span style="color: #94a3b8;">Генерация ответа:</span>
                    <span id="ag-pop-out" style="font-weight: 500; color: #f8fafc;">-</span>
                    <div style="grid-column: 1 / -1; height: 1px; background: rgba(255,255,255,0.08); margin: 4px 0;"></div>
                    <span style="color: #94a3b8;">Всего занято:</span>
                    <span id="ag-pop-total" style="font-weight: 600; color: #38bdf8;">-</span>
                    <span style="color: #94a3b8;">Порог авто-сжатия:</span>
                    <span id="ag-pop-limit-val" style="font-weight: 500; color: #e2e8f0;">-</span>
                    <span style="color: #94a3b8;">Остаток до сжатия:</span>
                    <span id="ag-pop-rem" style="font-weight: 600; color: #4ade80;">-</span>
                    <span style="color: #94a3b8;">Шагов до сжатия:</span>
                    <span id="ag-pop-steps" style="font-weight: 600; color: #4ade80;">-</span>
                </div>
                <div id="ag-pop-tip" style="
                    margin-top: 8px;
                    padding: 6px 8px;
                    background: rgba(56, 189, 248, 0.1);
                    border: 1px solid rgba(56, 189, 248, 0.2);
                    border-radius: 6px;
                    font-size: 10px;
                    color: #bae6fd;
                    line-height: 1.3;
                ">
                    Рабочий режим контекста.
                </div>
            </div>
        \`;

        document.body.appendChild(container);

        const btnInfo = document.getElementById('ag-hud-btn-info');
        const popover = document.getElementById('ag-hud-popover');
        const btnMin = document.getElementById('ag-hud-btn-min');
        const btnClose = document.getElementById('ag-hud-btn-close');
        const label = document.getElementById('ag-hud-label');

        if (btnInfo) {
            btnInfo.onclick = (e) => {
                e.stopPropagation();
                isExpanded = !isExpanded;
                if (popover) popover.style.display = isExpanded ? 'block' : 'none';
            };
        }

        if (btnMin) {
            btnMin.onclick = (e) => {
                e.stopPropagation();
                isMinimized = !isMinimized;
                if (label) label.style.display = isMinimized ? 'none' : 'flex';
                if (isMinimized && isExpanded) {
                    isExpanded = false;
                    if (popover) popover.style.display = 'none';
                }
            };
        }

        if (btnClose) {
            btnClose.onclick = async (e) => {
                e.stopPropagation();
                try {
                    await electron_1.ipcRenderer.invoke('antigravity:toggle-context-hud', false);
                } catch {}
                container.remove();
            };
        }

        let isDragging = false;
        let startX = 0, startY = 0, origX = 0, origY = 0;

        container.onmousedown = (e) => {
            if (e.target.closest('button')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = container.getBoundingClientRect();
            origX = rect.left;
            origY = rect.top;
            const card = document.getElementById('ag-hud-card');
            if (card) card.style.cursor = 'grabbing';
            document.body.style.userSelect = 'none';
        };

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const newX = Math.max(10, Math.min(window.innerWidth - 100, origX + dx));
            const newY = Math.max(10, Math.min(window.innerHeight - 40, origY + dy));
            container.style.bottom = 'auto';
            container.style.left = \`\${newX}px\`;
            container.style.top = \`\${newY}px\`;
        });

        window.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            const card = document.getElementById('ag-hud-card');
            if (card) card.style.cursor = 'grab';
            document.body.style.userSelect = '';
            try {
                const rect = container.getBoundingClientRect();
                localStorage.setItem('ag_hud_pos', JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
            } catch {}
        });
    }

    async function updateTelemetry() {
        try {
            const data = await electron_1.ipcRenderer.invoke('antigravity:get-context-telemetry');
            const existingHud = document.getElementById('ag-context-hud');

            // Если плагин отключен или данных нет — удаляем плашку из интерфейса
            if (!data) {
                if (existingHud) existingHud.remove();
                return;
            }

            ensureHudElement();

            const hudCard = document.getElementById('ag-hud-card');
            const hudTokens = document.getElementById('ag-hud-tokens');
            const hudDot = document.getElementById('ag-hud-dot');

            const popStep = document.getElementById('ag-pop-step');
            const popIn = document.getElementById('ag-pop-in');
            const popCache = document.getElementById('ag-pop-cache');
            const popOut = document.getElementById('ag-pop-out');
            const popTotal = document.getElementById('ag-pop-total');
            const popLimitVal = document.getElementById('ag-pop-limit-val');
            const popRem = document.getElementById('ag-pop-rem');
            const popSteps = document.getElementById('ag-pop-steps');
            const popTip = document.getElementById('ag-pop-tip');

            if (!hudTokens || !hudDot || !hudCard) return;

            let accentColor = '#38bdf8';
            let borderColor = 'rgba(255, 255, 255, 0.12)';

            if (data.compactPercent >= 90 || data.remainingTokens === 0) {
                accentColor = '#f87171';
                borderColor = 'rgba(248, 113, 113, 0.5)';
            } else if (data.compactPercent >= 75) {
                accentColor = '#facc15';
                borderColor = 'rgba(250, 204, 21, 0.4)';
            }

            hudDot.style.background = accentColor;
            hudDot.style.boxShadow = \`0 0 8px \${accentColor}\`;
            hudCard.style.borderColor = borderColor;

            if (data.compactPercent >= 95 || data.remainingTokens === 0) {
                hudTokens.innerHTML = \`
                    <span style="color: #f87171; font-weight: 700;">⚠️ \${formatNumber(data.totalTokens)} / \${formatNumber(data.compactThreshold)}</span> 
                    <span style="opacity: 0.85;">(\${data.compactPercent}%) • Сжатие!</span>
                \`;
            } else if (data.compactPercent >= 75) {
                hudTokens.innerHTML = \`
                    <span style="color: #facc15; font-weight: 600;">⚡ \${formatNumber(data.totalTokens)} / \${formatNumber(data.compactThreshold)}</span> 
                    <span style="opacity: 0.85;">(\${data.compactPercent}%)</span> 
                    <span style="opacity: 0.4;">•</span> 
                    <span style="color: #fde047;">~\${data.stepsRemaining} \${getStepWord(data.stepsRemaining)}</span>
                \`;
            } else {
                hudTokens.innerHTML = \`
                    <span style="color: #38bdf8; font-weight: 600;">⚡ \${formatNumber(data.totalTokens)} / \${formatNumber(data.compactThreshold)}</span> 
                    <span style="opacity: 0.75;">(\${data.compactPercent}%)</span> 
                    <span style="opacity: 0.4;">•</span> 
                    <span style="color: #cbd5e1;">~\${data.stepsRemaining} \${getStepWord(data.stepsRemaining)}</span>
                \`;
            }

            if (popStep) popStep.textContent = \`Шаг #\${data.currentStep}\`;
            if (popIn) popIn.textContent = formatNumber(data.inputTokens);
            if (popCache) popCache.textContent = formatNumber(data.cacheTokens);
            if (popOut) popOut.textContent = formatNumber(data.outputTokens);
            if (popTotal) popTotal.textContent = \`\${formatNumber(data.totalTokens)} / \${formatNumber(data.compactThreshold)} (\${data.compactPercent}%)\`;
            if (popLimitVal) popLimitVal.textContent = formatNumber(data.compactThreshold);
            if (popRem) {
                popRem.textContent = \`\${formatNumber(data.remainingTokens)} токенов\`;
                popRem.style.color = data.compactPercent >= 90 ? '#f87171' : (data.compactPercent >= 75 ? '#facc15' : '#4ade80');
            }
            if (popSteps) {
                popSteps.textContent = data.compactPercent >= 95 ? '0 (сжатие неизбежно)' : \`~\${data.stepsRemaining} \${getStepWord(data.stepsRemaining)}\`;
                popSteps.style.color = data.compactPercent >= 90 ? '#f87171' : (data.compactPercent >= 75 ? '#facc15' : '#4ade80');
            }
            if (popTip) {
                if (data.compactPercent >= 90) {
                    popTip.style.background = 'rgba(239, 68, 68, 0.15)';
                    popTip.style.borderColor = 'rgba(239, 68, 68, 0.3)';
                    popTip.style.color = '#fca5a5';
                    popTip.textContent = \`Контекст приблизился к порогу сжатия (~\${formatNumber(data.compactThreshold)})! Рекомендуется Safe Handoff или команда /compact.\`;
                } else if (data.compactPercent >= 75) {
                    popTip.style.background = 'rgba(234, 179, 8, 0.15)';
                    popTip.style.borderColor = 'rgba(234, 179, 8, 0.3)';
                    popTip.style.color = '#fde047';
                    popTip.textContent = \`Внимание: израсходовано \${data.compactPercent}% порога сжатия. До сжатия сессии осталось ~\${formatNumber(data.remainingTokens)} токенов (~\${data.stepsRemaining} шагов).\`;
                } else {
                    popTip.style.background = 'rgba(56, 189, 248, 0.1)';
                    popTip.style.borderColor = 'rgba(56, 189, 248, 0.2)';
                    popTip.style.color = '#bae6fd';
                    popTip.textContent = \`Рабочий режим. До авто-сжатия (~\${formatNumber(data.compactThreshold)}) осталось ~\${formatNumber(data.remainingTokens)} токенов (~\${data.stepsRemaining} шагов).\`;
                }
            }
        } catch (e) {}
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(updateTelemetry, 800));
    } else {
        setTimeout(updateTelemetry, 800);
    }

    setInterval(updateTelemetry, 3500);
})();
`;

function runPatch() {
  const { asarPath, bakPath } = getAsarPaths();

  if (!fs.existsSync(asarPath)) {
    console.error(`[Context Monitor] Файл app.asar не найден по пути: ${asarPath}`);
    process.exit(1);
  }

  console.log(`[Context Monitor] Найден app.asar: ${asarPath}`);

  // Создание резервной копии
  if (!fs.existsSync(bakPath)) {
    console.log(`[Context Monitor] Создание резервной копии: ${bakPath}...`);
    fs.copyFileSync(asarPath, bakPath);
  } else {
    console.log(`[Context Monitor] Резервная копия уже существует: ${bakPath}`);
  }

  const tmpDir = path.join(os.tmpdir(), `antigravity_patch_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    console.log('[Context Monitor] Извлечение архива app.asar...');
    execSync(`npx asar extract "${asarPath}" "${tmpDir}"`, { stdio: 'inherit' });

    // 1. Модификация dist/ipcHandlers.js
    const ipcFile = path.join(tmpDir, 'dist', 'ipcHandlers.js');
    if (fs.existsSync(ipcFile)) {
      let ipcContent = fs.readFileSync(ipcFile, 'utf8');
      if (!ipcContent.includes('antigravity:get-context-telemetry')) {
        console.log('[Context Monitor] Внедрение IPC-обработчика в dist/ipcHandlers.js...');
        const lastBrace = ipcContent.lastIndexOf('}');
        if (lastBrace !== -1) {
          ipcContent = ipcContent.slice(0, lastBrace) + IPC_HANDLER_SNIPPET + '\n}\n';
          fs.writeFileSync(ipcFile, ipcContent, 'utf8');
        }
      } else {
        console.log('[Context Monitor] IPC-обработчик уже присутствует.');
      }
    }

    // 2. Модификация dist/preload.js
    const preloadFile = path.join(tmpDir, 'dist', 'preload.js');
    if (fs.existsSync(preloadFile)) {
      let preloadContent = fs.readFileSync(preloadFile, 'utf8');
      if (!preloadContent.includes('initContextHud')) {
        console.log('[Context Monitor] Внедрение HUD-модуля в dist/preload.js...');
        preloadContent += '\n' + PRELOAD_HUD_SNIPPET + '\n';
        fs.writeFileSync(preloadFile, preloadContent, 'utf8');
      } else {
        console.log('[Context Monitor] HUD-модуль уже присутствует.');
      }
    }

    // 3. Упаковка обратно
    console.log('[Context Monitor] Упаковка модифицированного архива...');
    execSync(`npx asar pack "${tmpDir}" "${asarPath}" --unpack "**/node_modules/chrome-devtools-mcp/**"`, { stdio: 'inherit' });

    console.log('[Context Monitor] ✅ Патч успешно применен!');
    console.log('[Context Monitor] Перезапустите приложение Antigravity, чтобы увидеть индикатор контекста.');
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

function runUnpatch() {
  const { asarPath, bakPath } = getAsarPaths();

  if (!fs.existsSync(bakPath)) {
    console.error(`[Context Monitor] Резервная копия не найдена: ${bakPath}`);
    process.exit(1);
  }

  console.log(`[Context Monitor] Восстановление из резервной копии: ${bakPath}...`);
  fs.copyFileSync(bakPath, asarPath);
  console.log('[Context Monitor] ✅ Исходный app.asar успешно восстановлен!');
}

const arg = process.argv[2];
if (arg === 'unpatch' || arg === 'restore' || arg === 'revert') {
  runUnpatch();
} else {
  runPatch();
}
