/**
 * Face2Face — 談判評分（MASTER_PLAN §25）
 *
 * 分數由 server 端依實際訊號計算，不交給 LLM 決定，這樣同樺的表現
 * 每次得到的分數才會一致。LLM 只負責產生質性的教練回饋文字，
 * 而且一樺要先 validate 才能用。
 *
 * Evidence 20 / Positioning 20 / Discovery 15 /
 * Concession Discipline 20 / Creative Alternatives 15 / Clarity 10 = 100
 */

const OpenAI = require('openai');
const { LLMError, MODEL } = require('./llm');
const { scenarioOf } = require('../utils/negotiation');

const WEIGHTS = {
  evidence: 20,
  positioning: 20,
  discovery: 15,
  concessionDiscipline: 20,
  creativeAlternatives: 15,
  clarity: 10
};

const SKILL_LABELS = {
  evidence: '提出依據',
  positioning: '定位與爭取',
  discovery: '探詢資訊',
  concessionDiscipline: '讓步紀律',
  creativeAlternatives: '創造替代方案',
  clarity: '表達清晰'
};

function ratio(count, turns) {
  if (turns <= 0) return 0;
  return Math.min(1, count / turns);
}

/**
 * 依 session 的訊號統計算出各項分數。
 */
function computeScores(session) {
  const turns = session.turnCount;
  const tally = session.signalTally;

  // Evidence：提出市場數據 / 具體成果的比例
  const evidence = WEIGHTS.evidence * ratio(tally.usedEvidence, turns);

  // Positioning：最終條件相對於底線與目標的位置。
  // 'up' 是愈高愈好（談薪、報價），'down' 是愈低愈好（買車、租屋），
  // 所以「前進了多少」要依方向計算，不能一律用 offer - floor。
  const span = Math.abs(session.candidateTarget - session.candidateFloor);
  const progress = session.direction === 'down'
    ? session.candidateFloor - session.currentOffer
    : session.currentOffer - session.candidateFloor;
  const reachedFloor = session.direction === 'down'
    ? session.currentOffer <= session.candidateFloor
    : session.currentOffer >= session.candidateFloor;
  const positioningRatio = span > 0
    ? Math.max(0, Math.min(1, progress / span))
    : (reachedFloor ? 1 : 0);
  const positioning = WEIGHTS.positioning * positioningRatio;

  // Discovery：反問 / 探詢的比例
  const discovery = WEIGHTS.discovery * ratio(tally.askedQuestion, turns);

  // Concession Discipline：自行退讓愈少愈好（滿分為完全沒有主動降低要求）
  const concessionDiscipline = WEIGHTS.concessionDiscipline * (1 - ratio(tally.madeConcession, turns));

  // Creative Alternatives：提出非薪資條件的比例
  const creativeAlternatives = WEIGHTS.creativeAlternatives * ratio(tally.mentionedAlternative, turns);

  // Clarity：發言長度落在可讀區間的比例（過短沒有內容，過長失焦）
  const userTurns = session.history.filter(h => h.role === 'user');
  const clearTurns = userTurns.filter(h => {
    const len = h.content.trim().length;
    return len >= 15 && len <= 300;
  }).length;
  const clarity = WEIGHTS.clarity * ratio(clearTurns, userTurns.length);

  const breakdown = {
    evidence: Math.round(evidence),
    positioning: Math.round(positioning),
    discovery: Math.round(discovery),
    concessionDiscipline: Math.round(concessionDiscipline),
    creativeAlternatives: Math.round(creativeAlternatives),
    clarity: Math.round(clarity)
  };

  const total = Object.values(breakdown).reduce((sum, n) => sum + n, 0);

  return { breakdown, total };
}

/**
 * 依各項「得分率」找出最強與最弱的能力，而非直接比原始分數
 * （各項滿分不同，比原始分數會偏袒權重高的項目）。
 */
function rankSkills(breakdown) {
  const rates = Object.entries(breakdown).map(([key, score]) => ({
    key,
    label: SKILL_LABELS[key],
    rate: score / WEIGHTS[key]
  }));
  rates.sort((a, b) => b.rate - a.rate);
  return {
    strongest: rates[0],
    weakest: rates[rates.length - 1]
  };
}

// ==================== 教練回饋 ====================

function validateCoaching(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LLMError('教練回饋不是物件', 'BAD_SHAPE');
  }
  if (typeof raw.biggestMistake !== 'string' || raw.biggestMistake.trim() === '') {
    throw new LLMError('biggestMistake 缺失', 'BAD_COACHING');
  }
  if (typeof raw.suggestedBetterResponse !== 'string' || raw.suggestedBetterResponse.trim() === '') {
    throw new LLMError('suggestedBetterResponse 缺失', 'BAD_COACHING');
  }
  if (!Array.isArray(raw.tips) || raw.tips.length !== 3) {
    throw new LLMError('tips 必須是 3 個元素的陣列', 'BAD_COACHING');
  }
  for (const tip of raw.tips) {
    if (typeof tip !== 'string' || tip.trim() === '') {
      throw new LLMError('tips 內含空項目', 'BAD_COACHING');
    }
  }
  return {
    biggestMistake: raw.biggestMistake.trim(),
    suggestedBetterResponse: raw.suggestedBetterResponse.trim(),
    tips: raw.tips.map(t => t.trim())
  };
}

/**
 * 產生質性回饋。
 *
 * 送出去的是完整逐字稿（雙方發言都有——教練要看得到對話脈絡），
 * 但不含 internalLimit，也不含對手的內部狀態與訊號統計原始值。
 */
async function generateCoaching(session, scores, ranked) {
  const scenario = scenarioOf(session);
  if (!process.env.OPENAI_API_KEY) {
    throw new LLMError('OPENAI_API_KEY 未設定', 'NO_API_KEY');
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const transcript = session.history
    .map(h => `${h.role === 'user' ? scenario.role : scenario.avatarRole}：${h.content}`)
    .join('\n');

  const goalWord = session.direction === 'down' ? '希望壓到' : '目標';
  const floorWord = session.direction === 'down' ? '最多可接受' : '底線';
  const unit = scenario.currency;
  const prompt = `以下是一場談判練習的逐字稿。使用者的身分是${scenario.role}，對手是${scenario.avatarRole}。使用者的${goalWord} ${unit}${session.candidateTarget}，${floorWord} ${unit}${session.candidateFloor}，最終談到 ${unit}${session.currentOffer}。

系統評分：總分 ${scores.total}/100，最強項是「${ranked.strongest.label}」，最弱項是「${ranked.weakest.label}」。

逐字稿：
${transcript}

請以談判教練的身分，用繁體中文只輸出 JSON，不要 markdown 圍欄：
{
  "biggestMistake": "使用者最關鍵的一個失誤，具體指出發生在哪句話，1-2 句",
  "tips": ["可立即執行的建議 1", "建議 2", "建議 3"],
  "suggestedBetterResponse": "針對那個失誤，示範一句更好的說法，寫成可以直接照唸的一段話"
}`;

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 700,
    response_format: { type: 'json_object' }
  });

  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new LLMError('教練回饋未回傳內容', 'EMPTY_RESPONSE');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new LLMError('教練回饋不是合法 JSON', 'BAD_JSON');
  }

  return validateCoaching(parsed);
}

/**
 * 組出完整報告。教練回饋失敗不會讓整份報告消失 —— 分數是
 * server 算出來的，永遠拿得到；缺的只有質性建議，並且明說。
 */
async function buildReport(session) {
  const scores = computeScores(session);
  const ranked = rankSkills(scores.breakdown);

  const report = {
    total: scores.total,
    breakdown: scores.breakdown,
    weights: WEIGHTS,
    labels: SKILL_LABELS,
    finalOffer: session.currentOffer,
    outcome: session.outcome,
    rounds: session.round,
    strongestSkill: ranked.strongest.label,
    weakestSkill: ranked.weakest.label,
    coaching: null,
    coachingError: null
  };

  try {
    report.coaching = await generateCoaching(session, scores, ranked);
  } catch (error) {
    console.error('教練回饋產生失敗:', error.message);
    report.coachingError = error.code || 'COACHING_FAILED';
  }

  return report;
}

module.exports = {
  WEIGHTS,
  SKILL_LABELS,
  computeScores,
  rankSkills,
  validateCoaching,
  buildReport
};
