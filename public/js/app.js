/**
 * Perxona Connect Frontend
 * 遵循 Perxona Connect Kit Developer Handbook 規範
 *
 * 初始化分兩段（手冊 Runtime Flow）：
 *   1. preload()  — 頁面載入時：載入 Presenter 模組、取 Connect Key 與資源清單
 *   2. launch()   — 必須在「直接使用者手勢」內：resumeAudioPlayback() → initializeWithConnectKey()
 * 瀏覽器 autoplay policy 會擋掉非手勢觸發的音訊，因此不能在頁面載入時直接初始化。
 */

const chatForm = document.getElementById('chatForm');
const userInput = document.getElementById('userInput');
const messages = document.getElementById('messages');
const sendBtn = document.getElementById('sendBtn');
const status = document.getElementById('status');
const presenter = document.getElementById('presenter');
const launchBtn = document.getElementById('launchBtn');
const launchOverlay = document.getElementById('launchOverlay');
const testSpeechBtn = document.getElementById('testSpeechBtn');

let sessionId = null;
let isProcessing = false;
let connectKey = null;
let selectedAvatarId = null;
let selectedSceneId = null;
let selectedVoiceId = null;
let isReady = false;

// ==================== 階段 1：預先載入 ====================

async function preload() {
  status.textContent = '載入 Presenter 模組...';

  // 1. 取得 Config
  const config = await fetchJson('/api/config');

  // 2. 載入 Presenter 模組（元素已宣告在 DOM，模組載入後才會 upgrade）
  await loadPresenterScript(config.presenterUrl);
  await customElements.whenDefined('sv-presenter');

  // 3. 取得 Connect Key（publishable key，由後端提供）
  status.textContent = '取得 Connect Key...';
  const keyData = await fetchJson('/api/connect-key');
  connectKey = keyData.connectKey;
  if (!connectKey) throw new Error('Connect Key 不存在');

  // 4. 取得資源清單
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

  console.log('資源就緒:', {
    avatar: selectedAvatarId,
    scene: selectedSceneId,
    voice: selectedVoiceId
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

    // initializeWithConnectKey() resolve 只代表 target 已解析、speech token
    // 已發放；真正的 Ready 由 PRESENTER_STATUS 事件決定（Handbook §18）。
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

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error || `${url} 回傳 ${res.status}`);
  }
  return data;
}

// ==================== 訊息處理 ====================

async function sendMessage(message) {
  if (isProcessing) return;
  isProcessing = true;
  sendBtn.disabled = true;

  try {
    addMessage(message, 'user');
    status.textContent = '處理中...';

    const data = await fetchJson('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        sessionId,
        avatar_id: selectedAvatarId,
        voice_id: selectedVoiceId
      })
    });

    sessionId = data.sessionId;
    addMessage(data.reply, 'bot');

    if (isReady) {
      status.textContent = 'Avatar 呈現中...';
      // present() 不會 reject，必須檢查回傳結果
      const result = await presenter.present(data.presentation?.presentation || data.reply);
      if (result && result.success === false) {
        console.warn('present 失敗:', result.code, result.message);
        showError(`Avatar 呈現失敗 (${result.code}): ${result.message}`);
      }
    } else {
      // 清理交給 finally，這裡只標示狀態。
      status.textContent = '尚未啟動 Avatar';
      return;
    }

    status.textContent = '待機中';
  } catch (error) {
    console.error('Error:', error);
    addMessage(error.message || '抱歉，發生錯誤，請稍後再試', 'bot');
    status.textContent = '發生錯誤';
  } finally {
    isProcessing = false;
    sendBtn.disabled = false;
    userInput.value = '';
    userInput.focus();
  }
}

function addMessage(text, role) {
  const div = document.createElement('div');
  div.className = 'message ' + role;
  div.innerHTML = '<div class="message-content">' + escapeHtml(text) + '</div>';
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

function showError(message) {
  const div = document.createElement('div');
  div.className = 'message bot';
  div.innerHTML = '<div class="message-content" style="color: #ef4444;">⚠️ ' + escapeHtml(message) + '</div>';
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

// ==================== 事件綁定 ====================

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const message = userInput.value.trim();
  if (message) sendMessage(message);
});

launchBtn.addEventListener('click', launch);

// PRESENTER_STATUS 是 Ready 的唯一真實來源。
// 'Uninitialized' | 'Initializing' | 'Ready'
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
});

// Handbook §19：Presenter Ready 後先不要接 LLM，只測固定語句。
const FIXED_TEST_SENTENCE = '你好，我是你的談判教練。';

testSpeechBtn.addEventListener('click', async () => {
  if (!isReady) return;
  testSpeechBtn.disabled = true;
  try {
    // present() 不會 reject，必須檢查 structured result。
    const result = await presenter.present(FIXED_TEST_SENTENCE);
    console.log('present() result:', result);
    if (result && result.success === false) {
      showError(`present 失敗 (${result.code}): ${result.message}`);
    } else {
      addMessage(FIXED_TEST_SENTENCE, 'bot');
    }
  } catch (error) {
    console.error('present 例外:', error);
    showError('present 例外: ' + error.message);
  } finally {
    testSpeechBtn.disabled = !isReady;
  }
});

presenter.addEventListener('CONNECT_KEY_REJECTED', () => {
  // key 被拒沒有 refresh 可退，這是終態：把所有依賴 Ready 的操作一併關掉，
  // 否則按鈕仍亮著、點了卻因 `if (!isReady) return;` 靜默無反應。
  isReady = false;
  testSpeechBtn.disabled = true;
  sendBtn.disabled = true;
  status.textContent = 'Connect key 被拒絕';
  showError('Connect key 被拒絕，請到 Console 重新發放並確認 allowed domains 是否包含目前網域');
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
