/**
 * 對外部署用的保護層（MASTER_PLAN §30）
 *
 * 本機 demo 沒有這層也能跑，但一旦部署到公開網域，/api/* 就是
 * 任何人都能打的付費水龍頭：
 *   POST /api/negotiation/respond  每次燒 OpenAI（600 max_tokens）
 *   POST /api/presentation         每次燒 Perxona 額度
 * 這裡做三件事：每個 IP 的頻率上限、全站每日總量上限、選填的存取碼。
 *
 * 狀態存在記憶體：單一 instance 夠用（Render free tier 就是單一
 * instance）。多 instance 時每台各自計算，會變成寬鬆 N 倍——
 * 真的要擴的時候要換成 Redis，不要以為這層還準。
 */

const WINDOW_MS = 60 * 60 * 1000;        // 每 IP 的滑動視窗：1 小時
const DAY_MS = 24 * 60 * 60 * 1000;

// 每個 IP 每小時的上限。付費的抓緊，唯讀的放寬。
const PER_IP_LIMITS = {
  llm: 40,          // /negotiation/respond：最貴的一支
  session: 15,      // /negotiation/start：每場都會建 session
  presentation: 30, // /presentation：燒 Perxona 額度
  catalog: 200      // avatars / scenes / voices / motions / scenarios
};

// 全站每日總量。IP 限制擋不住分散來源，這條是最後的花費天花板。
const DAILY_LIMITS = {
  llm: Number(process.env.DAILY_LLM_LIMIT) || 600,
  presentation: Number(process.env.DAILY_PRESENTATION_LIMIT) || 400
};

const hits = new Map();      // `${bucket}:${ip}` -> number[]（timestamp）
const daily = new Map();     // bucket -> { day, count }

function pruneHits() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, times] of hits) {
    const kept = times.filter(t => t > cutoff);
    if (kept.length === 0) hits.delete(key);
    else hits.set(key, kept);
  }
}

// 視窗外的紀錄不會自己消失，沒有這個清理 Map 會隨不同 IP 無限成長
setInterval(pruneHits, WINDOW_MS).unref();

function dayStamp() {
  return Math.floor(Date.now() / DAY_MS);
}

function checkDaily(bucket) {
  const limit = DAILY_LIMITS[bucket];
  if (!limit) return true;

  const today = dayStamp();
  const entry = daily.get(bucket);
  if (!entry || entry.day !== today) {
    daily.set(bucket, { day: today, count: 1 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

/**
 * @param {string} bucket - PER_IP_LIMITS 的鍵
 */
function rateLimit(bucket) {
  const perIp = PER_IP_LIMITS[bucket];

  return (req, res, next) => {
    // app.set('trust proxy') 之後 req.ip 才是真實來源；
    // 沒設定的話所有請求都會是同一個 proxy IP，等於全站共用一個額度。
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    const times = (hits.get(key) ?? []).filter(t => t > now - WINDOW_MS);

    if (times.length >= perIp) {
      return res.status(429).json({
        error: '請求太頻繁，請稍後再試',
        retryAfterMinutes: Math.ceil((times[0] + WINDOW_MS - now) / 60000)
      });
    }

    if (!checkDaily(bucket)) {
      // 這條是花費上限，不是使用者的錯，訊息要說清楚是今日額度用完
      return res.status(429).json({
        error: '今日的示範額度已用完，請明天再試'
      });
    }

    times.push(now);
    hits.set(key, times);
    next();
  };
}

/**
 * 選填的存取碼。設了 DEMO_ACCESS_CODE 才會啟用。
 *
 * 這不是身分驗證，只是一道讓連結不被隨手轉傳濫用的閘門：
 * 所有人共用同一組碼，也沒有帳號概念。真的要做權限管理不能用這個。
 */
function accessGate() {
  const expected = process.env.DEMO_ACCESS_CODE;
  if (!expected) return (req, res, next) => next();

  return (req, res, next) => {
    const provided = req.get('x-demo-code') || req.query.code;
    if (provided === expected) return next();
    res.status(401).json({ error: '需要存取碼', code: 'ACCESS_CODE_REQUIRED' });
  };
}

function accessCodeRequired() {
  return Boolean(process.env.DEMO_ACCESS_CODE);
}

module.exports = { rateLimit, accessGate, accessCodeRequired, PER_IP_LIMITS, DAILY_LIMITS };
