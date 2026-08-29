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
const scenarioSelect = document.getElementById('scenarioSelect');
const customForm = document.getElementById('customForm');
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
let currentReaction = null;   // §24：LLM 只輸出 semantic reaction
let motionByPose = {};        // pose tag -> 該 avatar 實際的 motion_id

// ==================== 工具 ====================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

// 部署版可能要求存取碼。這不是身分驗證，只是避免連結被隨手轉傳後
// 有人把額度打光；所有人共用同一組碼。
const ACCESS_CODE_KEY = 'perxona.demo.code';

function storedAccessCode() {
  try {
    return localStorage.getItem(ACCESS_CODE_KEY) || '';
  } catch {
    // 隱私模式下 localStorage 會丟例外，退回這次 session 用就好
    return '';
  }
}

function rememberAccessCode(code) {
  try {
    localStorage.setItem(ACCESS_CODE_KEY, code);
  } catch {
    /* 存不起來不影響這次使用 */
  }
}

function promptAccessCode(message = '請輸入存取碼') {
  const code = window.prompt(message);
  if (code) rememberAccessCode(code.trim());
  return code ? code.trim() : '';
}

async function fetchJson(url, options) {
  const code = storedAccessCode();
  const opts = code
    ? { ...options, headers: { ...(options?.headers ?? {}), 'x-demo-code': code } }
    : options;
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => null);

  // 存取碼錯或未提供：問一次再重試。只重試一次，避免碼一直錯時無限迴圈。
  if (res.status === 401 && data?.code === 'ACCESS_CODE_REQUIRED' && !options?._retried) {
    const entered = promptAccessCode(
      code ? '存取碼不正確，請重新輸入' : '這個示範需要存取碼'
    );
    if (entered) {
      return fetchJson(url, { ...options, _retried: true });
    }
  }

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

  await loadScenarios();
  await loadMotions();
}

/**
 * §24 Motion 映射。
 *
 * Motion ID 是綁 avatar 的（tags 裡有 skeleton:f_cc092），換一個 avatar 就全部失效，
 * 所以這裡寫死的是 pose tag，實際 ID 一律從該 avatar 的 catalog 查出來。
 * 查不到就不播 —— 發明一個 ID 只會靜默不播，比不播更難查。
 */
async function loadMotions() {
  motionByPose = {};
  try {
    const data = await fetchJson(`/api/avatars/${encodeURIComponent(selectedAvatarId)}/motions?page=1&size=100`);
    for (const m of data.items ?? []) {
      const pose = (m.tags ?? []).find(t => t.startsWith('pose:'));
      if (pose && m.motion_id) {
        motionByPose[pose.slice('pose:'.length)] = m.motion_id;
      }
    }
    const loaded = Object.keys(motionByPose).length;
    console.log('Motion catalog:', Object.keys(motionByPose).join(', ') || '(空)');

    // 只載到第一頁時要說出來：沒說的話，超出的 pose 會因為
    // 「查不到就不播」而靜默失效，看起來像是那個 reaction 沒有動作。
    const total = data.total;
    if (typeof total === 'number' && total > (data.items?.length ?? 0)) {
      console.warn(
        `Motion 清單只載入 ${data.items?.length ?? 0} / ${total} 個，` +
        '超出的 pose 將無對應動作。'
      );
    }
  } catch (error) {
    // 沒有 motion 只是少了表情動作，不該讓整個 Avatar 起不來
    console.warn('Motion 清單取得失敗，將不播放動作:', error.message);
  }
}

// reaction -> 偏好的 pose，依序取第一個該 avatar 真的有的。
// 都沒有就不播，不退回猜測。
const REACTION_POSES = {
  positive:  ['talking_02', 'talking_01'],
  skeptical: ['idle_02', 'listening_01'],
  firm:      ['talking_03', 'idle_02'],
  surprised: ['talking_01', 'talking_02'],
  neutral:   ['idle_01', 'talking_01']
};

function resolveMotion(reaction) {
  for (const pose of REACTION_POSES[reaction] ?? []) {
    if (motionByPose[pose]) return { pose, motionId: motionByPose[pose] };
  }
  return null;
}

/**
 * 播放 reaction 對應的動作。與語音佇列獨立，不 await 說話。
 */
async function playReaction(reaction) {
  // 兩個呼叫點都是 fire-and-forget（沒有 await、也沒有 .catch），
  // 所以這裡面任何未捕捉的錯誤都會變成 unhandled rejection：
  // 表徵是「Motion 完全不動、console 也沒有任何 warn」。
  // 因此整個函式體都包在 try 內，解析與播放都不例外。
  try {
    const resolved = resolveMotion(reaction);
    if (!resolved) return;
    const result = await presenter.playMotion(resolved.motionId);
    if (result && result.success === false) {
      console.warn('playMotion 失敗:', resolved.pose, result.code, result.message);
    }
  } catch (error) {
    console.warn('playMotion 例外:', error.message);
  }
}

/**
 * 載入可選情境。清單來自 server 的白名單投影，
 * 前端只認 id，不自行保存任何談判參數。
 */
const CUSTOM_ID = '__custom__';

function syncCustomForm() {
  customForm.hidden = scenarioSelect.value !== CUSTOM_ID;
}

/**
 * 讀出自訂表單。空白與型別在這裡只做基本檢查，
 * 真正的規則（順序、範圍、授權極限推導）一律由 server 判斷 ——
 * 前端擋不住直接打 API 的人，重複一套規則只會兩邊漂移。
 */
function readCustomForm() {
  const num = (el) => {
    const v = Number(el.value);
    return Number.isFinite(v) ? v : NaN;
  };
  return {
    role: document.getElementById('cfRole').value.trim(),
    avatarRole: document.getElementById('cfAvatarRole').value.trim(),
    direction: document.getElementById('cfDirection').value,
    context: document.getElementById('cfContext').value.trim(),
    initialOffer: num(document.getElementById('cfInitial')),
    candidateTarget: num(document.getElementById('cfTarget')),
    candidateFloor: num(document.getElementById('cfFloor')),
    maxRounds: num(document.getElementById('cfRounds'))
  };
}

async function loadScenarios() {
  const data = await fetchJson('/api/negotiation/scenarios');
  const items = data.items ?? [];

  scenarioSelect.innerHTML = '';
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.id;
    // 情境名稱來自設定檔，仍以 textContent 寫入，不走 innerHTML
    opt.textContent = `${item.name}（${item.currency}${item.initialOffer.toLocaleString('zh-TW')} 起）`;
    scenarioSelect.appendChild(opt);
  }

  const customOpt = document.createElement('option');
  customOpt.value = CUSTOM_ID;
  customOpt.textContent = '✏️ 自訂情境...';
  scenarioSelect.appendChild(customOpt);

  if (items.length > 0) {
    scenarioSelect.value = items[0].id;
    scenarioSelect.disabled = false;
  } else {
    // 沒有可選情境時說清楚，不要留一個空選單讓人以為壞了
    const opt = document.createElement('option');
    opt.textContent = '沒有可用的情境';
    scenarioSelect.appendChild(opt);
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
    // 沒選時傳 undefined，由 server 用預設情境，不要讓沒選就壞掉
    const isCustom = scenarioSelect.value === CUSTOM_ID;
    const payload = isCustom
      ? { custom: readCustomForm() }
      : { scenarioId: scenarioSelect.value || undefined };

    const data = await fetchJson('/api/negotiation/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
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
    playReaction(data.reaction);
    startBtn.disabled = false;
    // 談判進行中不可換情境：換了會與 server 上那場 session 不一致
    scenarioSelect.disabled = true;
    customForm.hidden = true;

    await speak(data.reply);
  } catch (error) {
    console.error('開始談判失敗:', error);
    showError('開始談判失敗: ' + error.message);
    startBtn.textContent = negotiation ? '重新開始' : '重試開始';
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

    playReaction(data.reaction);
    await speak(data.reply);

    if (data.state.ended) {
      setInputEnabled(false);
      scenarioSelect.disabled = false;   // 談完可以換下一個情境
      syncCustomForm();
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
    } else if (error.status === 429) {
      showError(error.message);
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
scenarioSelect.addEventListener('change', syncCustomForm);
startBtn.addEventListener('click', startNegotiation);

// PRESENTER_STATUS 是 Ready 的唯一真實來源。
const STATUS_LABEL = {
  Uninitialized: '尚未初始化',
  Initializing: '初始化中...',
  Ready: '就緒'
};

/**
 * 鏡頭取景。人物在畫面上的大小是這裡決定的，不是容器尺寸——
 * Presenter 預設的垂直 FOV 是 90°，人物會被拉得很遠，
 * 容器再大也只是多出空白。
 * distance 越小越靠近人物；官方 motion-browser 用的是 distance: 1。
 */
const CAMERA = { distance: 0.55, vertical: 0, horizontal: 4.5 };

function applyCameraFraming() {
  if (typeof presenter.updateCameraFOV !== 'function') {
    console.warn('這版 Presenter 沒有 updateCameraFOV，維持預設取景');
    return;
  }
  presenter.updateCameraFOV({ ...CAMERA });
  console.log('鏡頭取景已套用:', CAMERA);
}

/**
 * 逼 canvas 重算縮放。
 *
 * Presenter 內部靠 ResizeObserver 調整 canvas 比例，但元素從隱藏變可見
 * 之後尺寸就不再變動，那段邏輯不會再觸發，canvas 會保留舊的縮放。
 * 把寬度推一個像素再推回來，製造一次真實的尺寸變化。
 * 兩次修改各自放在自己的 rAF（巢狀），確保瀏覽器會在兩者之間
 * 送出 ResizeObserver 通知。
 */
function nudgePresenterSize() {
  requestAnimationFrame(() => {
    presenter.style.width = 'calc(100% - 1px)';
    requestAnimationFrame(() => {
      presenter.style.width = '100%';
    });
  });
}

// 視窗改變大小時 canvas 同樣需要重算
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!isReady) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(nudgePresenterSize, 200);
});

presenter.addEventListener('PRESENTER_STATUS', (e) => {
  const presenterStatus = e.detail.status;
  console.log('Presenter status:', presenterStatus);
  isReady = presenterStatus === 'Ready';

  if (isReady) {
    applyCameraFraming();
    nudgePresenterSize();
  }
  status.textContent = STATUS_LABEL[presenterStatus] || presenterStatus;
  testSpeechBtn.disabled = !isReady;
  startBtn.disabled = !isReady;
  // 選單只在「還沒開始談判」或「已談完」時可用
  if (isReady && (!negotiation || negotiation.ended)) {
    scenarioSelect.disabled = false;
  }
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

  // 先問設定檔要不要碼，避免第一個需要碼的請求才跳出提示
  try {
    const cfg = await fetchJson('/api/config');
    if (cfg.accessCodeRequired && !storedAccessCode()) {
      promptAccessCode('這個示範需要存取碼');
    }
  } catch {
    /* 設定拿不到時交給 preload 的錯誤處理 */
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
