/**
 * Face2Face — 前端
 *
 * Presenter 初始化遵循 Perxona Connect Kit Developer Handbook 的 Runtime Flow：
 *   1. preload() — 頁面載入：載入 Presenter 模組、取 Connect Key 與資源清單
 *   2. launch()  — 必須在「直接使用者手勢」內：resumeAudioPlayback() → initializeWithConnectKey()
 *   3. Ready 由 PRESENTER_STATUS 事件決定，不是由 initialize resolve 決定
 *
 * 談判狀態一律以 server 回傳的 state 為準，前端不自行遞增回合或推算 offer —
 * 一旦自己算，就會和 server 的 clamp 結果分歧，而使用者只看得到前端那個數字。
 */

// ==================== DOM ====================

const chatForm = document.getElementById('chatForm');
const userInput = document.getElementById('userInput');
const messages = document.getElementById('messages');
const sendBtn = document.getElementById('sendBtn');
const status = document.getElementById('status');
const presenter = document.getElementById('presenter');
const launchBtn = document.getElementById('launchBtn');
const launchOverlay = document.getElementById('launchOverlay');
const testSpeechBtn = document.getElementById('testSpeechBtn');
const startBtn = document.getElementById('startBtn');
const scenarioTitle = document.getElementById('scenarioTitle');
const briefing = document.getElementById('briefing');
const stats = document.getElementById('stats');
const statRound = document.getElementById('statRound');
const statOffer = document.getElementById('statOffer');
const statTarget = document.getElementById('statTarget');
const statFloor = document.getElementById('statFloor');
const reportSection = document.getElementById('reportSection');
const reportBody = document.getElementById('reportBody');

// ==================== 狀態 ====================

let connectKey = null;
let selectedAvatarId = null;
let selectedSceneId = null;
let selectedVoiceId = null;
let isReady = false;          // 由 PRESENTER_STATUS 驅動
let isProcessing = false;

// 談判狀態：整份由 server 給，前端只讀
let negotiation = null;       // 最近一次 server 回傳的 state
let currentReaction = null;   // §24：只保存 semantic reaction，不映射 Motion ID
                              // 要映射必須先查 GET /assets/avatars/:id/motions 取得該
                              // avatar 實際支援的清單，絕不自行發明 Motion ID。

// ==================== 工具 ====================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(data?.error || `${url} 回傳 ${res.status}`);
    error.status = res.status;
    error.code = data?.code;
    throw error;
  }
  return data;
}

function formatMoney(amount) {
  const currency = negotiation?.currency ?? 'NT$';
  return `${currency}${Number(amount).toLocaleString('zh-TW')}`;
}

function addMessage(text, role) {
  const div = document.createElement('div');
  div.className = 'message ' + role;
  div.innerHTML = '<div class="message-content">' + escapeHtml(text) + '</div>';
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function showError(message) {
  const div = document.createElement('div');
  div.className = 'message bot';
  div.innerHTML = '<div class="message-content error">⚠️ ' + escapeHtml(message) + '</div>';
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

// ==================== 階段 1：預先載入 ====================

async function preload() {
  status.textContent = '載入 Presenter 模組...';
  const config = await fetchJson('/api/config');

  await loadPresenterScript(config.presenterUrl);
  await customElements.whenDefined('sv-presenter');

  status.textContent = '取得 Connect Key...';
  const keyData = await fetchJson('/api/connect-key');
  connectKey = keyData.connectKey;
  if (!connectKey) throw new Error('Connect Key 不存在');

  status.textContent = '取得 Avatar / Scene / Voice...';
  const [avatars, scenes, voices] = await Promise.all([
    fetchJson('/api/avatars'),
    fetchJson('/api/scenes'),
    fetchJson('/api/voices')
  ]);

  selectedAvatarId = avatars.items?.[0]?.avatar_id ?? null;
  selectedSceneId = scenes.items?.[0]?.scene_id ?? null;

  const voiceItems = voices.items ?? [];
  const zhVoice = voiceItems.find(v => Array.isArray(v.languages) && v.languages.includes('zh'));
  selectedVoiceId = (zhVoice ?? voiceItems[0])?.id ?? null;

  if (!selectedAvatarId || !selectedSceneId || !selectedVoiceId) {
    throw new Error('Avatar / Scene / Voice 設定不完整');
  }
}

function loadPresenterScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Presenter engine failed to load'));
    document.head.appendChild(script);
  });
}

// ==================== 階段 2：使用者手勢內啟動 ====================

async function launch() {
  launchBtn.disabled = true;
  launchBtn.textContent = '啟動中...';
  status.textContent = '啟動 Presenter...';

  try {
    // 必須在手勢內第一時間呼叫，才能解鎖 autoplay
    await presenter.resumeAudioPlayback();

    await presenter.initializeWithConnectKey(connectKey, {
      avatarId: selectedAvatarId,
      sceneId: selectedSceneId,
      voiceId: selectedVoiceId
    });

    launchOverlay.hidden = true;
    console.log('initializeWithConnectKey 完成，等待 PRESENTER_STATUS = Ready');
  } catch (error) {
    console.error('Presenter 啟動失敗:', error);
    showError('Presenter 啟動失敗: ' + error.message);
    launchBtn.disabled = false;
    launchBtn.textContent = '重試啟動';
    status.textContent = '啟動失敗';
  }
}

/**
 * 讓 Avatar 說話。present() 依 Handbook 不會 reject，
 * 必須檢查 structured result，否則失敗會靜默。
 */
async function speak(text) {
  if (!isReady) return;
  const result = await presenter.present(text);
  if (result && result.success === false) {
    console.warn('present 失敗:', result.code, result.message);
    showError(`Avatar 呈現失敗 (${result.code}): ${result.message}`);
  }
}

// ==================== 談判 ====================

function renderState(state) {
  // 完全採用 server 的 state，前端不自行計算任何數字
  negotiation = state;
  stats.hidden = false;
  statRound.textContent = `${state.round} / ${state.maxRounds}`;
  statOffer.textContent = formatMoney(state.currentOffer);
  statTarget.textContent = formatMoney(state.candidateTarget);
  statFloor.textContent = formatMoney(state.candidateFloor);
}

function setInputEnabled(enabled) {
  userInput.disabled = !enabled;
  sendBtn.disabled = !enabled;
}

async function startNegotiation() {
  startBtn.disabled = true;
  startBtn.textContent = '開始中...';

  try {
    const data = await fetchJson('/api/negotiation/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    scenarioTitle.textContent = data.briefing.title;
    briefing.innerHTML = [
      data.briefing.context,
      data.briefing.yourGoal,
      data.briefing.openingOffer,
      data.briefing.rounds
    ].map(line => `<p>${escapeHtml(line)}</p>`).join('');

    renderState(data.state);
    currentReaction = data.reaction;
    reportSection.hidden = true;
    reportBody.innerHTML = '';

    addMessage(data.reply, 'bot');
    setInputEnabled(true);
    userInput.focus();
    startBtn.textContent = '重新開始';
    startBtn.disabled = false;

    await speak(data.reply);
  } catch (error) {
    console.error('開始談判失敗:', error);
    showError('開始談判失敗: ' + error.message);
    startBtn.textContent = '重試開始';
    startBtn.disabled = false;
  }
}

async function sendResponse(message) {
  if (isProcessing || !negotiation || negotiation.ended) return;
  isProcessing = true;
  setInputEnabled(false);

  try {
    addMessage(message, 'user');
    userInput.value = '';
    status.textContent = 'HR 思考中...';

    const data = await fetchJson('/api/negotiation/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: negotiation.sessionId, message })
    });

    renderState(data.state);
    currentReaction = data.reaction;
    addMessage(data.reply, 'bot');

    await speak(data.reply);

    if (data.state.ended) {
      setInputEnabled(false);
      if (data.report) {
        renderReport(data.report);
      } else if (data.reportPending) {
        // server 說報告沒產生出來 —— 這裡必須真的去補抓，
        // 否則只是把死循環換成靜默遺失報告。
        await fetchReportWithRetry(data.state.sessionId);
      }
    } else {
      setInputEnabled(true);
      userInput.focus();
    }

    status.textContent = isReady ? '就緒' : '待機中';
  } catch (error) {
    console.error('談判錯誤:', error);
    if (error.code === 'NO_API_KEY' || error.status === 501) {
      showError('談判引擎未啟用：伺服器沒有設定 OPENAI_API_KEY，請在 .env 補上後重啟。');
      setInputEnabled(false);
    } else if (error.status === 502) {
      showError('AI 回應格式不正確，這一輪沒有生效，請換個說法再說一次。');
      setInputEnabled(true);
    } else if (error.status === 409) {
      showError('這場談判已經結束了，請按「重新開始」。');
      setInputEnabled(false);
    } else {
      showError(error.message);
      setInputEnabled(true);
    }
    status.textContent = '發生錯誤';
  } finally {
    isProcessing = false;
  }
}

// ==================== 報告 ====================

async function fetchReportWithRetry(sessionId) {
  reportSection.hidden = false;
  reportBody.innerHTML = '<p class="report-loading">正在產生談判報告...</p>';

  try {
    const report = await fetchJson(`/api/negotiation/${encodeURIComponent(sessionId)}/report`);
    renderReport(report);
  } catch (error) {
    console.error('報告取得失敗:', error);
    // 明確告知並給重試入口，不靜默
    reportBody.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'report-error';
    const msg = document.createElement('p');
    msg.textContent = '談判報告產生失敗：' + (error.message || '未知錯誤');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重試產生報告';
    retry.addEventListener('click', () => fetchReportWithRetry(sessionId));
    wrap.append(msg, retry);
    reportBody.appendChild(wrap);
  }
}

const OUTCOME_LABEL = {
  agreement: '達成共識',
  rounds_exhausted: '回合用盡，未達成共識',
  walked_away: '未成交（低於你的底線）'
};

/**
 * report 的每一個欄位都是 LLM 自由文字，全部經過 escapeHtml；
 * tips 是陣列，逐項處理，不能只處理外層。
 */
function renderReport(report) {
  reportSection.hidden = false;
  reportBody.innerHTML = '';

  const summary = document.createElement('div');
  summary.className = 'report-summary';
  summary.innerHTML = `
    <div class="score-big">${escapeHtml(String(report.total))}<span>/100</span></div>
    <dl>
      <div><dt>最終 Offer</dt><dd>${escapeHtml(formatMoney(report.finalOffer))}</dd></div>
      <div><dt>談判結果</dt><dd>${escapeHtml(OUTCOME_LABEL[report.outcome] || report.outcome)}</dd></div>
      <div><dt>進行回合</dt><dd>${escapeHtml(String(report.rounds))}</dd></div>
      <div><dt>最強項</dt><dd>${escapeHtml(report.strongestSkill)}</dd></div>
      <div><dt>最弱項</dt><dd>${escapeHtml(report.weakestSkill)}</dd></div>
    </dl>`;
  reportBody.appendChild(summary);

  const bars = document.createElement('div');
  bars.className = 'report-bars';
  for (const [key, score] of Object.entries(report.breakdown)) {
    const max = report.weights[key];
    const label = report.labels[key] || key;
    const pct = max > 0 ? Math.round((score / max) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <span class="bar-label">${escapeHtml(label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
      <span class="bar-score">${escapeHtml(String(score))} / ${escapeHtml(String(max))}</span>`;
    bars.appendChild(row);
  }
  reportBody.appendChild(bars);

  if (report.coaching) {
    const coaching = document.createElement('div');
    coaching.className = 'report-coaching';

    const mistake = document.createElement('section');
    mistake.innerHTML = `<h3>最大的一個失誤</h3><p>${escapeHtml(report.coaching.biggestMistake)}</p>`;
    coaching.appendChild(mistake);

    const tipsSection = document.createElement('section');
    const tipsTitle = document.createElement('h3');
    tipsTitle.textContent = '三個改進建議';
    const ol = document.createElement('ol');
    for (const tip of report.coaching.tips) {
      const li = document.createElement('li');
      li.textContent = tip;   // textContent：逐項都不走 innerHTML
      ol.appendChild(li);
    }
    tipsSection.append(tipsTitle, ol);
    coaching.appendChild(tipsSection);

    const better = document.createElement('section');
    better.innerHTML = `<h3>可以這樣說</h3><blockquote>${escapeHtml(report.coaching.suggestedBetterResponse)}</blockquote>`;
    coaching.appendChild(better);

    reportBody.appendChild(coaching);
  } else {
    const note = document.createElement('p');
    note.className = 'report-note';
    note.textContent = `教練回饋未產生（${report.coachingError || '未知原因'}），分數仍然有效。`;
    reportBody.appendChild(note);
  }

  reportSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ==================== 事件 ====================

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const message = userInput.value.trim();
  if (message) sendResponse(message);
});

launchBtn.addEventListener('click', launch);
startBtn.addEventListener('click', startNegotiation);

// PRESENTER_STATUS 是 Ready 的唯一真實來源。
const STATUS_LABEL = {
  Uninitialized: '尚未初始化',
  Initializing: '初始化中...',
  Ready: '就緒'
};

presenter.addEventListener('PRESENTER_STATUS', (e) => {
  const presenterStatus = e.detail.status;
  console.log('Presenter status:', presenterStatus);
  isReady = presenterStatus === 'Ready';
  status.textContent = STATUS_LABEL[presenterStatus] || presenterStatus;
  testSpeechBtn.disabled = !isReady;
  startBtn.disabled = !isReady;
});

presenter.addEventListener('CONNECT_KEY_REJECTED', () => {
  // key 被拒沒有 refresh 可退，這是終態：把所有依賴 Ready 的操作一併關掉。
  isReady = false;
  testSpeechBtn.disabled = true;
  startBtn.disabled = true;
  setInputEnabled(false);
  status.textContent = 'Connect key 被拒絕';
  showError('Connect key 被拒絕，請到 Console 重新發放並確認 allowed domains 是否包含目前網域');
});

// Handbook §19：不接 LLM 的固定語句測試，保留作為 Presenter 回歸檢查。
testSpeechBtn.addEventListener('click', async () => {
  if (!isReady) return;
  testSpeechBtn.disabled = true;
  try {
    await speak('你好，我是你的談判教練。');
  } finally {
    testSpeechBtn.disabled = !isReady;
  }
});

// ==================== 啟動 ====================

(async () => {
  try {
    await fetchJson('/health');
  } catch {
    showError('無法連接到伺服器');
    return;
  }

  try {
    await preload();
    launchBtn.disabled = false;
    launchBtn.textContent = '▶ 啟動 Avatar';
    status.textContent = '請點擊啟動 Avatar';
  } catch (error) {
    console.error('Perxona Connect 預先載入失敗:', error);
    showError('Perxona Connect 預先載入失敗: ' + error.message);
    launchBtn.textContent = '載入失敗';
    status.textContent = '載入失敗';
  }
})();
