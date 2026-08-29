/**
 * Face2Face — 談判 Session 狀態
 * MASTER_PLAN §20：internalMax、scoring、HR hidden state 必須留在 server-side。
 *
 * 這個模組是 hidden state 的唯一持有者。任何要送到瀏覽器的東西
 * 都必須經過 toClient()，它只挑出可公開欄位；絕對不要把 session
 * 物件直接 res.json() 出去。
 */

const { v4: uuidv4 } = require('uuid');
const scenarios = require('../../config/scenarios.json');

const sessions = new Map();

// 談判結束的原因（§23 提前結束條件）
const OUTCOME = {
  AGREEMENT: 'agreement',
  ROUNDS_EXHAUSTED: 'rounds_exhausted',
  WALKED_AWAY: 'walked_away'
};

function getScenario(scenarioId) {
  return scenarios[scenarioId] || null;
}

function createNegotiation(scenarioId = 'salary-junior-swe') {
  const scenario = getScenario(scenarioId);
  if (!scenario) {
    throw new Error(`未知的 scenario: ${scenarioId}`);
  }

  const session = {
    sessionId: uuidv4(),
    scenarioId: scenario.id,
    round: 1,
    maxRounds: scenario.maxRounds,

    initialOffer: scenario.initialOffer,
    currentOffer: scenario.initialOffer,
    candidateTarget: scenario.candidateTarget,
    candidateFloor: scenario.candidateFloor,

    // ⚠️ hidden：不得出現在任何回應中
    internalMax: scenario.internalMax,

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
 * 刻意不包含 internalMax、candidateFloor 以外的內部欄位；
 * candidateFloor / candidateTarget 是使用者自己的目標，可以顯示。
 */
function toClient(session) {
  const scenario = getScenario(session.scenarioId);
  return {
    sessionId: session.sessionId,
    scenarioId: session.scenarioId,
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
  createNegotiation,
  getNegotiation,
  toClient,
  _sessions: sessions
};
