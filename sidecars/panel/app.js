const sidecar = window.sidecar;
const $ = (id) => document.getElementById(id);

let toastTimer;
let currentWorkspacePath = '';
let currentModelPreset = 'gemini';
let currentWeatherMood = 'cloudy'; // 'cloudy' (0-40%) | 'rain' (40-70%) | 'storm' (>70%)

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
// Кинематографичный Процедурный Движок Погоды (Canvas 2D)
// -------------------------------------------------------------
function initWeatherCanvas() {
  const canvas = $('weather-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let rafId = 0;
  let isVisible = true;

  // Плавная интерполяция погодных состояний (Lerp)
  const current = {
    skyTop: [8, 24, 46],
    skyBottom: [22, 54, 88],
    cloudR: 210,
    cloudG: 226,
    cloudB: 245,
    cloudAlpha: 0.28,
    rainDensity: 0.0,
    rainSlant: 0.05,
    rainSpeed: 1.0,
    flashIntensity: 0.0,
  };

  const targets = {
    cloudy: {
      skyTop: [8, 24, 46],       // Спокойное вечернее небо
      skyBottom: [22, 54, 88],
      cloudR: 215,
      cloudG: 228,
      cloudB: 245,
      cloudAlpha: 0.32,
      rainDensity: 0.0,
      rainSlant: 0.0,            // Нет наклона
      rainSpeed: 0.7,
    },
    rain: {
      skyTop: [7, 16, 28],       // Пасмурное дождливое небо
      skyBottom: [15, 30, 48],
      cloudR: 120,
      cloudG: 138,
      cloudB: 160,
      cloudAlpha: 0.44,
      rainDensity: 0.65,
      rainSlant: 0.0,            // Чисто вертикальное отвесное падение (90°)
      rainSpeed: 0.85,           // Спокойный, медитативный ритм
    },
    storm: {
      skyTop: [3, 5, 12],        // Свинцовое грозовое небо
      skyBottom: [10, 14, 24],
      cloudR: 45,
      cloudG: 52,
      cloudB: 72,
      cloudAlpha: 0.58,
      rainDensity: 1.0,
      rainSlant: 0.07,           // Естественный легкий наклон по ветру (~4°)
      rainSpeed: 1.15,           // Плавная скорость без мельтешения
    },
  };

  // Процедурные облака с параллаксом
  const clouds = [
    { x: 30, y: 70, scale: 1.1, speed: 0.09, puffs: [
      { dx: 0, dy: 0, r: 48 }, { dx: 38, dy: -12, r: 40 }, { dx: -38, dy: -8, r: 38 },
      { dx: 68, dy: 8, r: 32 }, { dx: -68, dy: 10, r: 30 }, { dx: 18, dy: -26, r: 34 }
    ]},
    { x: 220, y: 140, scale: 0.85, speed: 0.06, puffs: [
      { dx: 0, dy: 0, r: 42 }, { dx: 32, dy: -10, r: 34 }, { dx: -32, dy: -6, r: 32 },
      { dx: 58, dy: 6, r: 28 }, { dx: -54, dy: 8, r: 26 }
    ]},
    { x: 420, y: 40, scale: 1.3, speed: 0.12, puffs: [
      { dx: 0, dy: 0, r: 54 }, { dx: 44, dy: -14, r: 46 }, { dx: -44, dy: -10, r: 42 },
      { dx: 82, dy: 10, r: 36 }, { dx: -80, dy: 12, r: 34 }, { dx: 24, dy: -28, r: 40 }
    ]},
    { x: 600, y: 190, scale: 0.95, speed: 0.08, puffs: [
      { dx: 0, dy: 0, r: 44 }, { dx: 34, dy: -10, r: 36 }, { dx: -34, dy: -8, r: 34 },
      { dx: 62, dy: 8, r: 28 }, { dx: -58, dy: 10, r: 26 }
    ]},
  ];

  // 3 Слоя глубины капель: дальний (мгла), средний, ближний
  // Всего 38 капель вместо 90: никакой каши, мельтешения и дергания глаз!
  const rainLayers = [
    { count: 18, width: 0.75, baseAlpha: 0.16, minLen: 8, maxLen: 13, minSpeed: 0.005, maxSpeed: 0.007 },
    { count: 14, width: 1.1, baseAlpha: 0.30, minLen: 14, maxLen: 20, minSpeed: 0.008, maxSpeed: 0.011 },
    { count: 6, width: 1.5, baseAlpha: 0.48, minLen: 22, maxLen: 28, minSpeed: 0.012, maxSpeed: 0.015 }
  ];

  const drops = [];
  rainLayers.forEach((layer) => {
    for (let i = 0; i < layer.count; i++) {
      drops.push({
        x: Math.random(),
        y: Math.random() * 1.3 - 0.2,
        speed: layer.minSpeed + Math.random() * (layer.maxSpeed - layer.minSpeed),
        length: layer.minLen + Math.random() * (layer.maxLen - layer.minLen),
        width: layer.width,
        alpha: layer.baseAlpha,
      });
    }
  });

  // Генератор грозовых вспышек
  let nextStrikeTime = Date.now() + 5000;
  let flashPulses = [];

  function triggerLightning() {
    const intensity = 0.5 + Math.random() * 0.5;
    flashPulses = [
      { startTime: Date.now(), peak: intensity, duration: 90 },
      { startTime: Date.now() + 110, peak: intensity * 0.65, duration: 140 },
    ];
    nextStrikeTime = Date.now() + 4500 + Math.random() * 6000;
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    width = canvas.clientWidth || window.innerWidth;
    height = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    if (!isVisible) return;

    const target = targets[currentWeatherMood] || targets.cloudy;
    const lerpSpeed = 0.035;

    // Плавное приближение цветов неба
    for (let i = 0; i < 3; i++) {
      current.skyTop[i] += (target.skyTop[i] - current.skyTop[i]) * lerpSpeed;
      current.skyBottom[i] += (target.skyBottom[i] - current.skyBottom[i]) * lerpSpeed;
    }
    current.cloudR += (target.cloudR - current.cloudR) * lerpSpeed;
    current.cloudG += (target.cloudG - current.cloudG) * lerpSpeed;
    current.cloudB += (target.cloudB - current.cloudB) * lerpSpeed;
    current.cloudAlpha += (target.cloudAlpha - current.cloudAlpha) * lerpSpeed;
    current.rainDensity += (target.rainDensity - current.rainDensity) * lerpSpeed;
    current.rainSlant += (target.rainSlant - current.rainSlant) * lerpSpeed;
    current.rainSpeed += (target.rainSpeed - current.rainSpeed) * lerpSpeed;

    // Расчет вспышки грозы
    let flash = 0;
    const now = Date.now();
    if (currentWeatherMood === 'storm' && now >= nextStrikeTime) {
      triggerLightning();
    }
    flashPulses = flashPulses.filter(p => now < p.startTime + p.duration);
    for (const p of flashPulses) {
      if (now >= p.startTime) {
        const progress = (now - p.startTime) / p.duration;
        flash += p.peak * Math.exp(-progress * 3.5);
      }
    }
    current.flashIntensity = Math.min(1, flash);

    // 1. Отрисовка Неба (Градиент)
    const skyGrad = ctx.createLinearGradient(0, 0, 0, height);
    const rTop = Math.min(255, Math.round(current.skyTop[0] + current.flashIntensity * 120));
    const gTop = Math.min(255, Math.round(current.skyTop[1] + current.flashIntensity * 130));
    const bTop = Math.min(255, Math.round(current.skyTop[2] + current.flashIntensity * 160));
    const rBot = Math.min(255, Math.round(current.skyBottom[0] + current.flashIntensity * 80));
    const gBot = Math.min(255, Math.round(current.skyBottom[1] + current.flashIntensity * 90));
    const bBot = Math.min(255, Math.round(current.skyBottom[2] + current.flashIntensity * 120));

    skyGrad.addColorStop(0, `rgb(${rTop}, ${gTop}, ${bTop})`);
    skyGrad.addColorStop(1, `rgb(${rBot}, ${gBot}, ${bBot})`);
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, width, height);

    // 2. Отрисовка Облаков
    const cloudR = Math.min(255, Math.round(current.cloudR + current.flashIntensity * 140));
    const cloudG = Math.min(255, Math.round(current.cloudG + current.flashIntensity * 150));
    const cloudB = Math.min(255, Math.round(current.cloudB + current.flashIntensity * 170));
    const cloudBaseAlpha = current.cloudAlpha;

    for (const c of clouds) {
      c.x += c.speed;
      const cloudW = 200 * c.scale;
      if (c.x - cloudW > width) {
        c.x = -cloudW;
      }

      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.scale(c.scale, c.scale * 0.75); // Приплюснутая естественная форма

      for (const p of c.puffs) {
        const puffGrad = ctx.createRadialGradient(p.dx, p.dy, 0, p.dx, p.dy, p.r);
        puffGrad.addColorStop(0, `rgba(${cloudR}, ${cloudG}, ${cloudB}, ${cloudBaseAlpha})`);
        puffGrad.addColorStop(0.7, `rgba(${cloudR}, ${cloudG}, ${cloudB}, ${cloudBaseAlpha * 0.65})`);
        puffGrad.addColorStop(1, `rgba(${cloudR}, ${cloudG}, ${cloudB}, 0)`);
        ctx.fillStyle = puffGrad;
        ctx.beginPath();
        ctx.arc(p.dx, p.dy, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // 3. Отрисовка Дождя / Ливня (Четкая сонаправленность траектории и шлейфа)
    if (current.rainDensity > 0.02) {
      const activeDropCount = Math.round(drops.length * current.rainDensity);
      const slant = current.rainSlant; // в дожде = 0 (чистая вертикаль), в шторме = 0.07

      for (let i = 0; i < activeDropCount; i++) {
        const d = drops[i];
        const stepY = d.speed * current.rainSpeed;
        const stepX = slant * stepY;

        d.y += stepY;
        d.x += stepX;

        if (d.y > 1.05) {
          d.y = -0.05 - Math.random() * 0.2;
          d.x = Math.random();
        }
        if (d.x > 1.05) d.x = -0.05;
        if (d.x < -0.05) d.x = 1.05;

        // Головка капли (нижняя ведущая точка, летит вниз)
        const headX = d.x * width;
        const headY = d.y * height;
        // Хвост капли (тянется сзади вверху строго по вектору скорости)
        const tailX = headX - slant * d.length;
        const tailY = headY - d.length;

        const grad = ctx.createLinearGradient(tailX, tailY, headX, headY);
        grad.addColorStop(0, `rgba(180, 215, 255, 0)`); // хвост плавно сходит на нет
        grad.addColorStop(1, `rgba(220, 240, 255, ${d.alpha * current.rainDensity})`); // закругленная четкая головка

        ctx.strokeStyle = grad;
        ctx.lineWidth = d.width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(headX, headY);
        ctx.stroke();
      }
    }

    // 4. Освещение зарницы на небе (DOM Flash)
    if (current.flashIntensity > 0.05) {
      ctx.fillStyle = `rgba(235, 245, 255, ${current.flashIntensity * 0.22})`;
      ctx.fillRect(0, 0, width, height);
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

    if ($('tokens-val')) {
      $('tokens-val').textContent = formatTokens(stats.totalContext);
    }
    if ($('tokens-limit-label')) {
      $('tokens-limit-label').textContent = `/ ${limitLabel}`;
    }
    if ($('tokens-text')) {
      $('tokens-text').textContent = `${formatTokens(stats.totalContext)} / ${limitLabel} токенов`;
    }
    if ($('gauge-footer-hint')) {
      $('gauge-footer-hint').textContent = `Окно внимания ${currentModelPreset === 'claude' ? 'Claude' : 'Gemini'}`;
    }

    // Детализация 2x2
    $('stat-input').textContent = formatTokens(stats.inputTokens);
    $('stat-cache').textContent = formatTokens(stats.cacheTokens);
    $('stat-output').textContent = formatTokens(stats.outputTokens);
    $('stat-steps').textContent = (stats.stepCount || 0).toLocaleString('ru-RU');

    progressBar.classList.remove('bar-cloudy', 'bar-rain', 'bar-storm');
    percentVal.classList.remove('percent-cloudy', 'percent-rain', 'percent-storm');
    zoneBadge.classList.remove('zone-cloudy', 'zone-rain', 'zone-storm');

    // Градации Token Weather (0-40% Облачно, 40-70% Дождь, >70% Шторм)
    if (percent < 40) {
      currentWeatherMood = 'cloudy';
      progressBar.classList.add('bar-cloudy');
      percentVal.classList.add('percent-cloudy');
      zoneBadge.classList.add('zone-cloudy');
      zoneBadge.textContent = 'Облачно';
      weatherIcon.textContent = '⛅';
      weatherStatusText.textContent = 'Облачно • Спокойное небо';
      weatherSubText.textContent = 'Контекст в норме (0–40%), стабильная скорость';
      recommendation.textContent = 'Запас памяти огромен. Продолжайте работу в обычном режиме.';
    } else if (percent < 70) {
      currentWeatherMood = 'rain';
      progressBar.classList.add('bar-rain');
      percentVal.classList.add('percent-rain');
      zoneBadge.classList.add('zone-rain');
      zoneBadge.textContent = 'Дождь';
      weatherIcon.textContent = '🌧️';
      weatherStatusText.textContent = 'Затяжной дождь';
      weatherSubText.textContent = `Контекст заполнен (~${percent}%). Готовьте срез задачи`;
      recommendation.textContent = 'История сессии накопилась. Рекомендуется подготовить Handoff.';
    } else {
      currentWeatherMood = 'storm';
      progressBar.classList.add('bar-storm');
      percentVal.classList.add('percent-storm');
      zoneBadge.classList.add('zone-storm');
      zoneBadge.textContent = 'Шторм';
      weatherIcon.textContent = '⛈️';
      weatherStatusText.textContent = 'Штормовое предупреждение';
      weatherSubText.textContent = 'Критический объем памяти! Высокий риск потери фокуса';
      recommendation.textContent = '⚠️ Контекст на пределе. Немедленно нажмите кнопку переноса в новый чат.';
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
