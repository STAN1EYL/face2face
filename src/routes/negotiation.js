/**
 * Face2Face — 談判路由（MASTER_PLAN §20-25）
 *
 * 送出去的東西一律經過 toClient()，internalMax 不會離開這台伺服器。
 * offer 金額只由 server 決定：前端從頭到尾沒有機會提供數字。
 */

const express = require('express');
const router = express.Router();

const {
  OUTCOME,
  getScenario,
  listScenarios,
  createNegotiation,
  getNegotiation,
  toClient
} = require('../utils/negotiation');
const { negotiate, LLMError } = require('../services/llm');
const { buildReport } = require('../services/scoring');

const MAX_MESSAGE_LENGTH = 1000;

/**
 * offer 的 server 端唯一真相。
 * LLM 建議的數字只是建議：不得低於檯面上的金額（HR 不會收回已開的條件），
 * 也不得超過內部授權上限。超界就夾回邊界，而不是照單全收。
 */
function clampOffer(suggested, session) {
  if (!Number.isFinite(suggested)) return session.currentOffer;
  const floor = session.currentOffer;
  const ceiling = session.internalMax;
  return Math.max(floor, Math.min(Math.round(suggested), ceiling));
}

function endNegotiation(session, reason) {
  session.ended = true;
  if (reason === 'rounds') {
    session.outcome = OUTCOME.ROUNDS_EXHAUSTED;
  } else if (session.currentOffer >= session.candidateFloor) {
    session.outcome = OUTCOME.AGREEMENT;
  } else {
    // 談到最後仍低於自己的底線 —— 視為沒有成交
    session.outcome = OUTCOME.WALKED_AWAY;
  }
}

// GET /api/negotiation/scenarios
// 回傳可選職位清單。走 listScenarios() 的白名單投影，
// 絕不直接吐 scenarios 物件 —— 那會把每個職位的 internalMax 一次送進瀏覽器。
router.get('/negotiation/scenarios', (req, res) => {
  res.json({ items: listScenarios() });
});

// POST /api/negotiation/start
// 開場不呼叫 LLM：opening offer 是 scenario 寫死的條件，
// 這樣即使 LLM 尚未設定，Avatar 也能先把場景說出來。
router.post('/negotiation/start', (req, res) => {
  try {
    const { scenarioId } = req.body || {};
    const session = createNegotiation(scenarioId || 'salary-junior-swe');
    const scenario = getScenario(session.scenarioId);

    // 開場白由情境自帶：求職與接案的用語不同（「起薪／每月」對接案是錯的），
    // 寫死在這裡的話，每加一個非求職情境就會講出不合場景的話。
    const opening = (scenario.opening || '')
      .replace('{role}', scenario.role)
      .replace('{currency}', scenario.currency)
      .replace('{offer}', String(scenario.initialOffer));

    session.history.push({ role: 'assistant', content: opening });

    res.json({
      state: toClient(session),
      briefing: scenario.briefing,
      reply: opening,
      reaction: 'neutral'
    });
  } catch (error) {
    console.error('Negotiation start error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// POST /api/negotiation/respond
router.post('/negotiation/respond', async (req, res) => {
  try {
    const { sessionId, message } = req.body || {};

    if (typeof sessionId !== 'string' || sessionId === '') {
      return res.status(400).json({ error: 'sessionId 為必填' });
    }
    if (typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ error: '訊息不能為空' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `訊息長度不可超過 ${MAX_MESSAGE_LENGTH} 字` });
    }

    const session = getNegotiation(sessionId);
    if (!session) {
      return res.status(404).json({ error: '找不到這場談判，請重新開始' });
    }
    if (session.ended) {
      return res.status(409).json({ error: '這場談判已結束', state: toClient(session) });
    }

    const scenario = getScenario(session.scenarioId);
    const userMessage = message.trim();

    const result = await negotiate(session, scenario, userMessage);

    // 先記錄對話，再套用 server 規則
    session.history.push({ role: 'user', content: userMessage });
    session.history.push({ role: 'assistant', content: result.reply });
    session.turnCount += 1;

    for (const [key, fired] of Object.entries(result.signals)) {
      if (fired) session.signalTally[key] += 1;
    }

    session.currentOffer = clampOffer(result.currentOffer, session);

    if (result.shouldEnd) {
      endNegotiation(session, 'agreement');
    } else if (session.round >= session.maxRounds) {
      endNegotiation(session, 'rounds');
    } else {
      session.round += 1;
    }

    const payload = {
      reply: result.reply,
      reaction: result.reaction,
      state: toClient(session)
    };

    if (session.ended) {
      // 報告失敗不該讓整場談判報銷：談判結果已經產生，缺的只是教練評語。
      // 若這裡拋出，session 已經是 ended，使用者照著 502 的「請再說一次」
      // 重試只會拿到 409，整場卡死。改為吞掉錯誤並讓前端改打
      // GET /api/negotiation/:sessionId/report（該端點會 lazy 重算）。
      try {
        session.report = await buildReport(session);
        payload.report = session.report;
      } catch (reportError) {
        console.error('報告產生失敗:', reportError.message);
        payload.reportPending = true;
      }
    }

    res.json(payload);
  } catch (error) {
    if (error instanceof LLMError) {
      console.error('Negotiation LLM error:', error.code, error.message);
      if (error.code === 'NO_API_KEY') {
        return res.status(501).json({
          error: 'OPENAI_API_KEY 未設定，談判引擎無法運作',
          code: error.code
        });
      }
      // 驗證失敗不當成成功：明確告訴前端這一輪沒有生效，可以重試
      return res.status(502).json({
        error: 'AI 回應格式不正確，請再說一次',
        code: error.code
      });
    }
    console.error('Negotiation error:', error.message);
    res.status(500).json({ error: '抱歉，發生錯誤，請稍後再試' });
  }
});

// GET /api/negotiation/:sessionId/report
router.get('/negotiation/:sessionId/report', async (req, res) => {
  const session = getNegotiation(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: '找不到這場談判' });
  }
  if (!session.ended) {
    return res.status(409).json({ error: '談判尚未結束' });
  }
  if (!session.report) {
    session.report = await buildReport(session);
  }
  res.json(session.report);
});

module.exports = router;
