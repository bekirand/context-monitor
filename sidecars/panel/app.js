const sidecar = window.sidecar;
const $ = (id) => document.getElementById(id);

let toastTimer;
let currentWorkspacePath = '';
let currentModelPreset = 'gemini';
let currentWeatherMood = 'clear'; // 'clear' | 'cloudy' | 'storm'

function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function formatTokens(count) {
  if (count === null || count === undefined || isNaN(count)) return '0';
  if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
  if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
  return count.toLocaleString('ru-RU');
}

async function callApi(path, body = {}, method = 'POST') {
  const options = { method };
  if (method === 'POST') {
    options.body = JSON.stringify(body);
  }
  const res = await sidecar.fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return data;
}

function parseFileUriToPath(uri) {
  if (!uri) return '';
  let str = uri.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '');
  str = decodeURIComponent(str);
  return str.replace(/\//g, '\\');
}

// -------------------------------------------------------------
// Движок Живого Погодного Фона (Canvas 2D Mesh, <0.5% CPU)
// -------------------------------------------------------------
function initWeatherCanvas() {
  const canvas = $('weather-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let rafId = 0;
  let isVisible = true;

  // Капли дождя для режима шторма (легковесный пул)
  const drops = Array.from({ length: 28 }, () => ({
    x: Math.random(),
    y: Math.random(),
    speed: 0.015 + Math.random() * 0.02,
    length: 12 + Math.random() * 14,
  }));

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    width = canvas.clientWidth || window.innerWidth;
    height = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(time = 0) {
    if (!isVisible) return;
    ctx.clearRect(0, 0, width, height);

    // Базовый темный фон
    ctx.fillStyle = '#030712';
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'screen';

    // Конфигурация сфер в зависимости от погодного настроения
    let p1Color, p2Color;
    if (currentWeatherMood === 'storm') {
      p1Color = 'rgba(225, 29, 72, 0.28)';   // Грозовой розово-красный
      p2Color = 'rgba(79, 70, 229, 0.32)';  // Глубокий индиго
    } else if (currentWeatherMood === 'cloudy') {
      p1Color = 'rgba(217, 119, 6, 0.24)';   // Янтарные сумерки
      p2Color = 'rgba(124, 58, 237, 0.26)';  // Фиолетовый
    } else {
      p1Color = 'rgba(2, 132, 199, 0.26)';   // Спокойный лазурный
      p2Color = 'rgba(56, 189, 248, 0.22)';  // Небесный циан
    }

    // 1-я парящая сфера
    const drift1X = (Math.sin(time * 0.0002) * 0.25 + 0.5) * width;
    const drift1Y = (Math.cos(time * 0.00025) * 0.2 + 0.3) * height;
    const grad1 = ctx.createRadialGradient(drift1X, drift1Y, 0, drift1X, drift1Y, Math.max(width, height) * 0.65);
    grad1.addColorStop(0, p1Color);
    grad1.addColorStop(1, 'rgba(3, 7, 18, 0)');
    ctx.fillStyle = grad1;
    ctx.fillRect(0, 0, width, height);

    // 2-я парящая сфера
    const drift2X = (Math.cos(time * 0.00018) * 0.25 + 0.5) * width;
    const drift2Y = (Math.sin(time * 0.00022) * 0.2 + 0.7) * height;
    const grad2 = ctx.createRadialGradient(drift2X, drift2Y, 0, drift2X, drift2Y, Math.max(width, height) * 0.65);
    grad2.addColorStop(0, p2Color);
    grad2.addColorStop(1, 'rgba(3, 7, 18, 0)');
    ctx.fillStyle = grad2;
    ctx.fillRect(0, 0, width, height);

    // Дождь при шторме (>70%)
    if (currentWeatherMood === 'storm') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const d of drops) {
        d.y += d.speed;
        if (d.y > 1) d.y = 0;
        const x = d.x * width;
        const y = d.y * height;
        ctx.moveTo(x, y);
        ctx.lineTo(x - 2, y + d.length);
      }
      ctx.stroke();
    }

    rafId = requestAnimationFrame(draw);
  }

  resize();
  rafId = requestAnimationFrame(draw);

  window.addEventListener('resize', () => {
    cancelAnimationFrame(rafId);
    resize();
    draw();
  });

  document.addEventListener('visibilitychange', () => {
    isVisible = !document.hidden;
    if (isVisible) {
      rafId = requestAnimationFrame(draw);
    } else {
      cancelAnimationFrame(rafId);
    }
  });
}

// -------------------------------------------------------------
// Логика виджета и отображения
// -------------------------------------------------------------

function setModelPresetUI(preset) {
  currentModelPreset = preset;
  $('preset-gemini').classList.toggle('active', preset === 'gemini');
  $('preset-claude').classList.toggle('active', preset === 'claude');
}

async function loadSettingsUI() {
  try {
    const s = await callApi('/api/settings', {}, 'GET');
    const badge = $('mode-badge');
    const status = $('key-status');
    if (s.modelPreset) {
      setModelPresetUI(s.modelPreset);
    }
    if (s.hasApiKey) {
      badge.textContent = '⚡ AI API (1 клик)';
      badge.className = 'badge ok';
      status.textContent = `Ключ сохранен: ${s.maskedKey}`;
    } else {
      badge.textContent = '📝 Локальный (без API)';
      badge.className = 'badge';
      status.textContent = 'Ключ не задан (работает локально через агента)';
    }
  } catch (err) {
    console.error('Ошибка загрузки настроек:', err);
  }
}

async function selectModelPreset(preset) {
  try {
    await callApi('/api/settings', { modelPreset: preset }, 'POST');
    setModelPresetUI(preset);
    toast(`Выбран профиль: ${preset === 'claude' ? 'Claude 200k' : 'Gemini 1.0M'}`);
    updateContextStats();
  } catch (err) {
    toast('Ошибка переключения: ' + err.message, true);
  }
}

async function saveApiKey() {
  const input = $('api-key-input');
  const key = input.value.trim();
  try {
    const res = await callApi('/api/settings', { apiKey: key }, 'POST');
    input.value = '';
    toast(res.hasApiKey ? 'Ключ Gemini сохранен!' : 'Ключ удален');
    loadSettingsUI();
  } catch (err) {
    toast('Ошибка сохранения: ' + err.message, true);
  }
}

async function updateContextStats() {
  if (!sidecar || !sidecar.conversationId) {
    $('status-badge').textContent = 'Нет сессии';
    $('status-badge').className = 'badge error';
    return;
  }

  try {
    const stats = await callApi('/api/context-stats', { conversationId: sidecar.conversationId });

    if (!stats.active) {
      $('status-badge').textContent = 'Ожидание';
      $('status-badge').className = 'badge';
      return;
    }

    $('status-badge').textContent = 'Подключено';
    $('status-badge').className = 'badge ok';

    const percent = Math.min(100, Math.max(0, stats.percent || 0));
    const progressBar = $('progress-bar');
    const percentVal = $('percent-val');
    const zoneBadge = $('zone-status');
    const recommendation = $('recommendation-text');
    const weatherIcon = $('weather-icon');
    const weatherStatusText = $('weather-status-text');
    const weatherSubText = $('weather-sub-text');
    const limitLabel = stats.limitLabel || (stats.limit >= 1000000 ? '1.0M' : '200k');

    percentVal.textContent = `${percent}%`;
    progressBar.style.width = `${percent}%`;
    $('tokens-text').textContent = `${formatTokens(stats.totalContext)} / ${limitLabel} токенов`;

    // Детализация 2x2
    $('stat-input').textContent = formatTokens(stats.inputTokens);
    $('stat-cache').textContent = formatTokens(stats.cacheTokens);
    $('stat-output').textContent = formatTokens(stats.outputTokens);
    $('stat-steps').textContent = (stats.stepCount || 0).toLocaleString('ru-RU');

    progressBar.classList.remove('bar-clear', 'bar-cloudy', 'bar-storm');
    zoneBadge.classList.remove('zone-clear', 'zone-cloudy', 'zone-storm');

    // Градации Token Weather
    if (percent < 40) {
      currentWeatherMood = 'clear';
      progressBar.classList.add('bar-clear');
      zoneBadge.classList.add('zone-clear');
      zoneBadge.textContent = 'Штиль';
      weatherIcon.textContent = '☀️';
      weatherStatusText.textContent = 'Ясно • Полный штиль';
      weatherSubText.textContent = 'Контекст чист, модель на пике внимания';
      recommendation.textContent = 'Запас контекста огромен. Спокойно продолжайте разработку.';
    } else if (percent < 70) {
      currentWeatherMood = 'cloudy';
      progressBar.classList.add('bar-cloudy');
      zoneBadge.classList.add('zone-cloudy');
      zoneBadge.textContent = 'Облачно';
      weatherIcon.textContent = '⛅';
      weatherStatusText.textContent = 'Переменная облачность';
      weatherSubText.textContent = `Накопление истории (~${percent}%). Следите за расходом`;
      recommendation.textContent = 'Контекст ощутимо заполнен. При замедлении ответов выполните перенос.';
    } else {
      currentWeatherMood = 'storm';
      progressBar.classList.add('bar-storm');
      zoneBadge.classList.add('zone-storm');
      zoneBadge.textContent = 'Шторм';
      weatherIcon.textContent = '⛈️';
      weatherStatusText.textContent = 'Штормовое предупреждение';
      weatherSubText.textContent = 'Высокий риск забывания деталей. Пора делать Handoff!';
      recommendation.textContent = '⚠️ Контекст на пределе. Рекомендуется немедленно начать новый чат со сводкой.';
    }
  } catch (err) {
    console.error('Ошибка обновления статистики:', err);
  }
}

// Запуск процесса Handoff
async function triggerHandoff() {
  const btn = $('handoff-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Формирование среза...';

  try {
    const res = await callApi('/api/handoff', {
      conversationId: sidecar.conversationId,
      workspacePath: currentWorkspacePath,
    });

    if (res.mode === 'gemini-api') {
      toast('✅ Сводка готова! Открываем новый диалог...');
      const summaryText = res.summary || 'Сводка проекта успешно подготовлена.';
      const initialPrompt = `${summaryText}\n\n---\nКонтекст перенесен успешно. Готов продолжать задачу с 0% токенов.`;
      
      btn.textContent = '🚀 Запуск сессии...';
      await sidecar.agent.startConversation(initialPrompt);
      toast('Новый диалог запущен!');
      btn.disabled = false;
      btn.textContent = '🚀 Новый чат со сводкой (Handoff)';
    } else {
      toast('📄 Инструкция сохранена. Агент формирует срез...', false);
      const instruction = `Сформируй компактный срез сессии (Primary Intent, Решения, Файлы, Текущий статус) и сохрани в ${res.summaryFile || 'handoff-summary.md'}`;
      await sidecar.agent.sendMessage(instruction);
      btn.textContent = '⌛ Ожидание агента...';
      pollSummaryReady(res.summaryFile);
    }
  } catch (err) {
    toast('Ошибка Handoff: ' + err.message, true);
    btn.disabled = false;
    btn.textContent = '🚀 Новый чат со сводкой (Handoff)';
  }
}

function pollSummaryReady(summaryFile) {
  let attempts = 0;
  const timer = setInterval(async () => {
    attempts++;
    if (attempts > 30) {
      clearInterval(timer);
      const btn = $('handoff-btn');
      btn.disabled = false;
      btn.textContent = '🚀 Новый чат со сводкой (Handoff)';
      toast('Превышено время ожидания сводки', true);
      return;
    }

    try {
      const check = await callApi('/api/check-summary', { summaryFile });
      if (check.ready) {
        clearInterval(timer);
        toast('🎉 Срез готов! Начинаем новую сессию...');
        const prompt = `${check.content}\n\n---\nКонтекст перенесен. Начинаем работу с чистого листа.`;
        await sidecar.agent.startConversation(prompt);
        const btn = $('handoff-btn');
        btn.disabled = false;
        btn.textContent = '🚀 Новый чат со сводкой (Handoff)';
      }
    } catch {}
  }, 3000);
}

async function init() {
  initWeatherCanvas();

  if (!sidecar) {
    $('status-badge').textContent = 'Вне среды Antigravity';
    $('status-badge').className = 'badge error';
    return;
  }

  try {
    const uris = await sidecar.getWorkspaceUris();
    if (uris && uris.length > 0) {
      currentWorkspacePath = parseFileUriToPath(uris[0]);
    }
    sidecar.onWorkspaceChange((newUris) => {
      if (newUris && newUris.length > 0) {
        currentWorkspacePath = parseFileUriToPath(newUris[0]);
      }
    });
  } catch {}

  $('preset-gemini').addEventListener('click', () => selectModelPreset('gemini'));
  $('preset-claude').addEventListener('click', () => selectModelPreset('claude'));

  $('handoff-btn').addEventListener('click', triggerHandoff);
  $('refresh-btn').addEventListener('click', () => {
    toast('Обновление...');
    updateContextStats();
  });
  $('api-key-save').addEventListener('click', saveApiKey);

  loadSettingsUI();
  updateContextStats();
  setInterval(updateContextStats, 3500);
}

init();
