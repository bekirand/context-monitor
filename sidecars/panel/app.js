const sidecar = window.sidecar;
const $ = (id) => document.getElementById(id);

let toastTimer;
let pollSummaryTimer;
let currentWorkspacePath = '';

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
  // На Windows декодируем %20 и слэши
  str = decodeURIComponent(str);
  return str.replace(/\//g, '\\');
}

async function loadSettingsUI() {
  try {
    const s = await callApi('/api/settings', {}, 'GET');
    const badge = $('mode-badge');
    const status = $('key-status');
    if (s.hasApiKey) {
      badge.textContent = '⚡ Режим: AI API (1 клик)';
      badge.className = 'badge ok';
      status.textContent = `Ключ сохранен: ${s.maskedKey}`;
    } else {
      badge.textContent = '📝 Режим: Локальный (через агента)';
      badge.className = 'badge';
      status.textContent = 'Ключ не задан (работает без API через агента)';
    }
  } catch (err) {
    console.error('Ошибка загрузки настроек:', err);
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

    percentVal.textContent = `${percent}%`;
    progressBar.style.width = `${percent}%`;
    $('tokens-text').textContent = `${formatTokens(stats.totalContext)} / 1.0M токенов`;

    progressBar.classList.remove('bar-green', 'bar-yellow', 'bar-red');
    zoneBadge.classList.remove('zone-green', 'zone-yellow', 'zone-red');

    if (percent < 40) {
      progressBar.classList.add('bar-green');
      zoneBadge.classList.add('zone-green');
      zoneBadge.textContent = 'Оптимально';
      recommendation.textContent = 'Контекст в зеленой зоне. Запас огромен, модель работает на полной скорости.';
    } else if (percent < 70) {
      progressBar.classList.add('bar-yellow');
      zoneBadge.classList.add('zone-yellow');
      zoneBadge.textContent = 'Заполнено (~' + percent + '%)';
      recommendation.textContent = 'Контекст достаточно объемный. При замедлении выполните перенос.';
    } else {
      progressBar.classList.add('bar-red');
      zoneBadge.classList.add('zone-red');
      zoneBadge.textContent = 'Высокая нагрузка (' + percent + '%)';
      recommendation.textContent = '⚠️ Контекст превысил 700k токенов. Рекомендуется перенос в новый чат со сводкой.';
    }

    $('stat-input').textContent = formatTokens(stats.inputTokens);
    $('stat-cache').textContent = formatTokens(stats.cacheTokens);
    $('stat-output').textContent = formatTokens(stats.outputTokens);
    $('stat-steps').textContent = stats.stepCount ? `${stats.stepCount} записей` : '–';

  } catch (err) {
    $('status-badge').textContent = 'Ошибка';
    $('status-badge').className = 'badge error';
  }
}

async function triggerHandoff() {
  if (!sidecar || !sidecar.conversationId) {
    toast('Нет активного диалога', true);
    return;
  }

  const btn = $('handoff-btn');

  try {
    btn.disabled = true;
    btn.textContent = 'Проверка режима...';

    const payload = {
      conversationId: sidecar.conversationId,
      workspacePath: currentWorkspacePath
    };

    const res = await callApi('/api/prepare-handoff', payload);

    // 1. Прямой режим через API (или готовый файл)
    if (res.ready && res.summary) {
      btn.textContent = 'Создание нового чата...';
      await sidecar.agent.startConversation(res.summary, 'Продолжение работы');
      if (res.mode === 'local') {
        callApi('/api/clear-local-summary', { workspacePath: currentWorkspacePath }).catch(() => {});
      }
      toast('Новый чистый чат успешно открыт!');
      btn.disabled = false;
      btn.textContent = '🚀 Новый чат со сводкой';
      updateContextStats();
      return;
    }

    // 2. Локальный режим: запрашиваем сводку у текущего агента
    if (res.mode === 'local' && !res.ready) {
      btn.textContent = '⏳ Агент пишет сводку в файл...';
      toast('Запросил создание сводки у агента в чате...');
      await sidecar.agent.sendMessage(res.promptToAgent);

      // Запускаем опрос готовности файла
      clearInterval(pollSummaryTimer);
      pollSummaryTimer = setInterval(async () => {
        try {
          const check = await callApi('/api/prepare-handoff', payload);
          if (check.ready) {
            clearInterval(pollSummaryTimer);
            btn.disabled = false;
            btn.textContent = '🚀 Открыть новый чат со сводкой';
            btn.classList.add('ready-pulse');
            toast('Сводка готова на диске! Нажмите для открытия нового чата.');
          }
        } catch {}
      }, 2500);
    }

  } catch (err) {
    toast('Ошибка: ' + err.message, true);
    btn.disabled = false;
    btn.textContent = '🚀 Новый чат со сводкой';
  }
}

async function init() {
  if (!sidecar) {
    $('status-badge').textContent = 'Вне среды Antigravity';
    $('status-badge').className = 'badge error';
    return;
  }

  // Определение пути рабочей области
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
