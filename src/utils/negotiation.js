/**
 * Face2Face — 談判 Session 狀態
 * MASTER_PLAN §20：internalLimit、scoring、HR hidden state 必須留在 server-side。
 *
 * 這個模組是 hidden state 的唯一持有者。任何要送到瀏覽器的東西
 * 都必須經過 toClient()，它只挑出可公開欄位；絕對不要把 session
 * 物件直接 res.json() 出去。
 */

const { v4: uuidv4 } = require('uuid');
const scenarios = require('../../config/scenarios.json');

const sessions = new Map();

// 載入時檢查每個 scenario 的不變量。違反的話那個情境不管談得多好
// 都不可能成交，而使用者要談完整場才會發現 —— 寧可啟動時就失敗。
//
// direction 決定比較方向：
//   'up'   使用者要爭取更高（談薪、報價）：對方從低往上加，
//          成交條件 currentOffer >= candidateFloor，
//          所以授權上限必須 >= 使用者底線。
//   'down' 使用者要壓低（買車、租屋）：對方從高往下讓，
//          成交條件 currentOffer <= candidateFloor（此時 floor 是
//          使用者願意付的上限），所以授權下限必須 <= 該上限。
for (const [id, sc] of Object.entries(scenarios)) {
  if (sc.direction !== 'up' && sc.direction !== 'down') {
    throw new Error(`scenario "${id}" 缺少 direction（'up' 或 'down'）。`);
  }
  const reachable = sc.direction === 'up'
    ? sc.internalLimit >= sc.candidateFloor
    : sc.internalLimit <= sc.candidateFloor;
  if (!reachable) {
    throw new Error(
      `scenario "${id}" 設定錯誤：direction=${sc.direction} 時 ` +
      `internalLimit (${sc.internalLimit}) 越過了 candidateFloor ` +
      `(${sc.candidateFloor})，這個情境永遠無法達成共識。`
    );
  }
}

// 談判結束的原因（§23 提前結束條件）
const OUTCOME = {
  AGREEMENT: 'agreement',
  ROUNDS_EXHAUSTED: 'rounds_exhausted',
  WALKED_AWAY: 'walked_away'
};

/**
 * 送給瀏覽器的 scenario 清單。
 *
 * 白名單逐欄位列舉，絕不 res.json(scenarios) 或用 delete / spread 排除法：
 * 白名單漏掉欄位只是少顯示一個東西，黑名單漏掉欄位就是把 internalLimit
 * 一次全部送到瀏覽器。這裡刻意不包含 internalLimit 與 concessions。
 */
function listScenarios() {
  return Object.values(scenarios).map(sc => ({
    id: sc.id,
    name: sc.name,
    role: sc.role,
    direction: sc.direction,
    avatarRole: sc.avatarRole,
    currency: sc.currency,
    initialOffer: sc.initialOffer,
    candidateTarget: sc.candidateTarget,
    candidateFloor: sc.candidateFloor,
    maxRounds: sc.maxRounds,
    briefing: sc.briefing
  }));
}

function getScenario(scenarioId) {
  return scenarios[scenarioId] || null;
}

const MAX_TEXT = 200;
const MAX_AMOUNT = 1_000_000_000;

function requireText(value, field, max = 40) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} 必填`);
  }
  if (value.length > max) {
    throw new Error(`${field} 不可超過 ${max} 字`);
  }
  return value.trim();
}

function requireAmount(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} 必須是正數`);
  }
  if (value > MAX_AMOUNT) {
    throw new Error(`${field} 過大`);
  }
  return Math.round(value);
}

/**
 * 由使用者的目標與底線推導出對手的授權極限。
 *
 * 刻意不讓使用者自己填這個數字：自訂情境如果連底價都是自己輸入的，
 * 談判就只剩下打字，沒有探索空間。這裡取兩者之間的隨機位置，
 * 所以出題的人也不知道確切在哪裡，只知道大致範圍。
 *
 * 落點必定在 target 與 floor 之間，因此 createNegotiation 的
 * 可達成性不變量自動成立。
 */
function deriveInternalLimit(target, floor) {
  const span = Math.abs(target - floor);
  const ratio = 0.4 + Math.random() * 0.4;          // 0.4 ~ 0.8
  const step = Math.max(1000, Math.round(span / 20));
  const raw = floor + (target > floor ? 1 : -1) * span * ratio;
  const snapped = Math.round(raw / step) * step;

  const lo = Math.min(target, floor);
  const hi = Math.max(target, floor);
  return Math.max(lo, Math.min(snapped, hi));
}

/**
 * 把使用者填的表單變成一個一次性的 scenario。
 * 不寫入 scenarios，也不落檔——只活在這場 session 裡。
 */
function buildCustomScenario(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('自訂情境格式不正確');
  }

  const direction = input.direction === 'down' ? 'down' : 'up';
  const role = requireText(input.role, '你的身分');
  const avatarRole = requireText(input.avatarRole, '對方身分');
  const context = requireText(input.context, '情境說明', MAX_TEXT);

  const initialOffer = requireAmount(input.initialOffer, '對方開價');
  const candidateTarget = requireAmount(input.candidateTarget, '你的目標');
  const candidateFloor = requireAmount(input.candidateFloor, '你的底線');

  const maxRounds = Number.isInteger(input.maxRounds) ? input.maxRounds : 6;
  if (maxRounds < 3 || maxRounds > 10) {
    throw new Error('回合數必須介於 3 到 10');
  }

  // 順序檢查。順序錯了整場談判會從一開始就已經成交，或永遠談不動。
  if (direction === 'up') {
    if (!(initialOffer < candidateFloor && candidateFloor <= candidateTarget)) {
      throw new Error('爭取更高時，順序必須是：對方開價 < 你的底線 ≤ 你的目標');
    }
  } else if (!(initialOffer > candidateFloor && candidateFloor >= candidateTarget)) {
    throw new Error('壓低價格時，順序必須是：對方開價 > 你可接受的上限 ≥ 你的目標');
  }

  const currency = typeof input.currency === 'string' && input.currency.trim() !== ''
    ? input.currency.trim().slice(0, 5)
    : 'NT$';

  const goalLine = direction === 'down'
    ? `希望壓到 ${currency}${candidateTarget}，最多只能接受 ${currency}${candidateFloor}。`
    : `目標 ${currency}${candidateTarget}，可接受的底線是 ${currency}${candidateFloor}。`;

  return {
    id: 'custom',
    name: `自訂：${role}`,
    role,
    direction,
    avatarRole,
    currency,
    initialOffer,
    candidateTarget,
    candidateFloor,
    internalLimit: deriveInternalLimit(candidateTarget, candidateFloor),
    maxRounds,
    concessions: {},
    opening: `${context} 我們這邊的條件是 ${currency}${initialOffer}。想先聽聽你的想法。`,
    briefing: {
      title: `自訂情境：${role}`,
      context,
      yourGoal: goalLine,
      openingOffer: `對方開價 ${currency}${initialOffer}。`,
      rounds: `最多 ${maxRounds} 回合。`
    }
  };
}

/**
 * @param {string|Object} scenarioRef - 內建情境 id，或自訂情境表單物件
 */
function createNegotiation(scenarioRef = 'salary-junior-swe') {
  const scenario = typeof scenarioRef === 'object' && scenarioRef !== null
    ? buildCustomScenario(scenarioRef)
    : getScenario(scenarioRef);
  if (!scenario) {
    throw new Error(`未知的 scenario: ${scenarioRef}`);
  }

  const session = {
    sessionId: uuidv4(),
    scenarioId: scenario.id,
    scenario,                 // 自訂情境不在 scenarios 表裡，只能掛在 session 上
    direction: scenario.direction,
    round: 1,
    maxRounds: scenario.maxRounds,

    initialOffer: scenario.initialOffer,
    currentOffer: scenario.initialOffer,
    candidateTarget: scenario.candidateTarget,
    candidateFloor: scenario.candidateFloor,

    // ⚠️ hidden：不得出現在任何回應中
    internalLimit: scenario.internalLimit,

    concessions: Object.keys(scenario.concessions).reduce((acc, key) => {
      acc[key] = false;
      return acc;
    }, {}),

    history: [],
    signalTally: {
      usedEvidence: 0,
      askedQuestion: 0,
      madeConcession: 0,
      mentionedAlternative: 0
    },
    turnCount: 0,

    ended: false,
    outcome: null,
    report: null,
    createdAt: new Date().toISOString()
  };

  sessions.set(session.sessionId, session);
  return session;
}

function getNegotiation(sessionId) {
  return sessions.get(sessionId) || null;
}

/**
 * 送給瀏覽器的安全投影。
 * 刻意不包含 internalLimit、candidateFloor 以外的內部欄位；
 * candidateFloor / candidateTarget 是使用者自己的目標，可以顯示。
 */
/**
 * 取得這場 session 的 scenario。內建與自訂都走這裡——
 * 自訂情境不在 scenarios 表裡，用 id 是查不到的。
 */
function scenarioOf(session) {
  return session.scenario;
}

function toClient(session) {
  const scenario = scenarioOf(session);
  return {
    sessionId: session.sessionId,
    scenarioId: session.scenarioId,
    direction: session.direction,
    round: session.round,
    maxRounds: session.maxRounds,
    currency: scenario.currency,
    initialOffer: session.initialOffer,
    currentOffer: session.currentOffer,
    candidateTarget: session.candidateTarget,
    candidateFloor: session.candidateFloor,
    concessions: session.concessions,
    ended: session.ended,
    outcome: session.outcome
  };
}

module.exports = {
  OUTCOME,
  getScenario,
  scenarioOf,
  listScenarios,
  createNegotiation,
  getNegotiation,
  toClient,
  _sessions: sessions
};
