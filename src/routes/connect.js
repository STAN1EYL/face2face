/**
 * Perxona Connect API Routes
 * 遵循 Perxona Connect Kit Developer Handbook 規範
 */

const express = require('express');
const router = express.Router();
const {
  getAvatars,
  getScenes,
  getVoices,
  getChatbots,
  getAvatarMotions,
  createPresentation,
  getPublishableKey
} = require('../services/perxona');
const config = require('../../config/default.json');

// ── Region ────────────────────────────────────────────────────
// 官方 samples/express/.env.example：Presenter engine 的 CDN URL 是
// region-specific，必須與 PERXONA_API_BASE_URL 的 region 一致。
//   https://cdn.perxona.ai/asia/prod/latest/widget/entry/presenter.js
// 省略 region 段會落到 region-neutral engine，實測會去打 /eu/api/ → 401。
// 「Leaving them mismatched is the one combination that looks configured
//   and is not.」— 官方原文
// 因此這裡只從 PERXONA_API_BASE_URL 取出 region 段，再組出 Presenter URL，
// 讓兩者永遠同源，不會各自漂移。
const PERXONA_API_BASE_URL = process.env.PERXONA_API_BASE_URL;
const REGION_MATCH = PERXONA_API_BASE_URL && PERXONA_API_BASE_URL.match(/\/(asia|eu)(?:\/|$)/);
const REGION = (REGION_MATCH && REGION_MATCH[1]) || 'asia';

if (PERXONA_API_BASE_URL && !REGION_MATCH) {
  console.warn(
    `WARNING: PERXONA_API_BASE_URL 中找不到 /asia 或 /eu 區段，region 退回猜測值 "${REGION}"。\n` +
    '若組織不在該區，請將 PERXONA_API_BASE_URL 指向含正確 region 段的 URL。'
  );
}

// 可用 PRESENTER_URL 覆寫（官方同名變數）；未設定時依 region 組出。
const PRESENTER_URL =
  process.env.PRESENTER_URL ||
  `https://cdn.perxona.ai/${REGION}/prod/latest/widget/entry/presenter.js`;

// 覆寫值若帶了不同 region，這正是官方警告的「看起來有設定其實沒有」組合。
const PRESENTER_REGION_MATCH = PRESENTER_URL.match(/cdn\.perxona\.ai\/(asia|eu)\//);
if (PRESENTER_REGION_MATCH && PRESENTER_REGION_MATCH[1] !== REGION) {
  console.warn(
    `WARNING: PRESENTER_URL 的 region "${PRESENTER_REGION_MATCH[1]}" 與 API region "${REGION}" 不一致，` +
    'Presenter 會對錯誤的 region 認證並取得 401。'
  );
} else if (!PRESENTER_REGION_MATCH) {
  console.warn(
    'WARNING: PRESENTER_URL 沒有 region 段，會使用 region-neutral engine，' +
    '對 Asia 帳號會產生 401。'
  );
}

// 啟動自檢：把實際生效的 region 與 Presenter URL 印出來。
// 這兩個值被改錯時的症狀（瀏覽器 401）離原因很遠，所以在開機當下就攤開，
// 不要等到 Presenter 在瀏覽器裡失敗才回頭查。
console.log(`  Region    : ${REGION}`);
console.log(`  Presenter : ${PRESENTER_URL}`);

// 快取資源清單
let cache = {
  avatars: null,
  scenes: null,
  voices: null,
  chatbots: null,
  lastFetch: null
};

const CACHE_TTL = 5 * 60 * 1000;

function isCacheValid() {
  return cache.lastFetch && (Date.now() - cache.lastFetch < CACHE_TTL);
}

router.get('/config', (req, res) => {
  // 不可快取：region 改了卻讀到瀏覽器快取的舊 presenterUrl，
  // 症狀是 Presenter 對錯誤 region 認證並取得 401，離原因很遠。
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  res.json({
    presenterUrl: PRESENTER_URL,
    region: REGION
  });
});

router.get('/connect-key', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  const publishableKey = getPublishableKey();

  if (!publishableKey) {
    return res.status(500).json({
      error: 'PERXONA_CONNECT_PUBLISHABLE_KEY 未設定'
    });
  }

  res.json({ connectKey: publishableKey });
});

router.get('/avatars', async (req, res) => {
  try {
    if (cache.avatars && isCacheValid()) {
      return res.json(cache.avatars);
    }
    const data = await getAvatars();
    cache.avatars = data;
    cache.lastFetch = Date.now();
    res.json(data);
  } catch (error) {
    console.error('Error fetching avatars:', error.message);
    res.status(500).json({ error: '無法取得 Avatar 清單' });
  }
});

// GET /api/avatars/:avatarId/motions
// §24：reaction 要映射到 Motion ID 時，只能用這支拿到的清單。
// Motion ID 不在該 avatar 的 catalog 裡就不會播，所以絕不自行發明。
router.get('/avatars/:avatarId/motions', async (req, res) => {
  try {
    // 轉發分頁參數。不轉發的話一律吃 API 預設頁大小，
    // motion 多的 avatar 超出第一頁的 pose 就查不到，
    // 而「查不到就不播」會讓那些 reaction 靜默失效。
    const data = await getAvatarMotions(req.params.avatarId, {
      page: req.query.page,
      size: req.query.size
    });
    res.json(data);
  } catch (error) {
    console.error('Error fetching motions:', error.message);
    res.status(500).json({ error: '無法取得 Motion 清單' });
  }
});

router.get('/scenes', async (req, res) => {
  try {
    if (cache.scenes && isCacheValid()) {
      return res.json(cache.scenes);
    }
    const data = await getScenes();
    cache.scenes = data;
    cache.lastFetch = Date.now();
    res.json(data);
  } catch (error) {
    console.error('Error fetching scenes:', error.message);
    res.status(500).json({ error: '無法取得 Scene 清單' });
  }
});

router.get('/voices', async (req, res) => {
  try {
    if (cache.voices && isCacheValid()) {
      return res.json(cache.voices);
    }
    const data = await getVoices();
    cache.voices = data;
    cache.lastFetch = Date.now();
    res.json(data);
  } catch (error) {
    console.error('Error fetching voices:', error.message);
    res.status(500).json({ error: '無法取得 Voice 清單' });
  }
});

router.get('/chatbots', async (req, res) => {
  try {
    const data = await getChatbots();
    res.json(data);
  } catch (error) {
    console.error('Error fetching chatbots:', error.message);
    res.status(500).json({ error: '無法取得 Chatbot 清單' });
  }
});

router.post('/presentation', async (req, res) => {
  try {
    const { avatar_id, message, voice_id, emotion, intensity } = req.body;
    if (!avatar_id) {
      return res.status(400).json({ error: 'avatar_id 為必填' });
    }
    if (!message) {
      return res.status(400).json({ error: 'message 為必填' });
    }
    const result = await createPresentation({
      avatar_id,
      message,
      voice_id,
      emotion,
      intensity
    });
    res.json(result);
  } catch (error) {
    console.error('Error creating presentation:', error.message);
    res.status(500).json({ error: '無法產生 Presentation' });
  }
});

router.post('/chat', async (req, res) => {
  try {
    const { message, avatar_id, voice_id, sessionId } = req.body;
    if (!message || message.trim() === '') {
      return res.status(400).json({ error: '訊息不能為空' });
    }
    const avatarId = avatar_id || config.perxona?.defaultAvatarId || '01KVQ59VW18PC6P2HQET51NMYS';
    const presentation = await createPresentation({
      avatar_id: avatarId,
      message: message,
      voice_id: voice_id || config.perxona?.defaultVoiceId || '01KXFXEVFKN6FDHC74PDDK4NS2'
    });
    res.json({
      reply: presentation.presentation || presentation.display_text,
      presentation: presentation,
      avatar_id: avatarId,
      voice_id: voice_id,
      sessionId
    });
  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ error: '抱歉，發生錯誤，請稍後再試' });
  }
});

module.exports = router;
