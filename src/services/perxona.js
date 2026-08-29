/**
 * Perxona Connect API Service
 * 遵循 Perxona Connect Kit Developer Handbook 規範
 * API 文件: https://console.perxona.ai/asia/api/v1/connect
 */

const axios = require('axios');

// 官方 samples/express/server.mjs：所有 server 端 REST 呼叫都打
//   `${PERXONA_API_BASE_URL}/api/v1/connect/...`
// region 只有這一個來源，Presenter URL 也由它推導（見 routes/connect.js），
// 兩邊才不會一個 asia 一個 eu。
const API_BASE_URL =
  process.env.PERXONA_API_BASE_URL || 'https://console.perxona.ai/asia';
const BASE_URL = `${API_BASE_URL}/api/v1/connect`;

/**
 * 建立 axios 實例，自動加上 X-Connect-Key header
 */
function createClient() {
  const apiKey = process.env.PERXONA_CONNECT_SECRET_KEY;
  if (!apiKey) {
    throw new Error('PERXONA_CONNECT_KEY 環境變數未設定');
  }

  return axios.create({
    baseURL: BASE_URL,
    headers: {
      'X-Connect-Key': apiKey,
      'Content-Type': 'application/json'
    }
  });
}

// ==================== Catalog APIs ====================

/**
 * 取得 Avatar 清單
 * GET /assets/avatars
 */
async function getAvatars() {
  const client = createClient();
  const response = await client.get('/assets/avatars');
  return response.data;
}

/**
 * 取得單一 Avatar 詳情
 * GET /assets/avatars/{avatar_id}
 */
async function getAvatar(avatarId) {
  const client = createClient();
  const response = await client.get(`/assets/avatars/${avatarId}`);
  return response.data;
}

/**
 * 取得 Avatar 可用的 motions
 * GET /assets/avatars/{avatar_id}/motions
 */
async function getAvatarMotions(avatarId, { page, size } = {}) {
  const client = createClient();
  const params = {};
  if (page !== undefined) params.page = page;
  if (size !== undefined) params.size = size;
  const response = await client.get(`/assets/avatars/${avatarId}/motions`, { params });
  return response.data;
}

/**
 * 取得 Scene 清單
 * GET /assets/scenes
 */
async function getScenes() {
  const client = createClient();
  const response = await client.get('/assets/scenes');
  return response.data;
}

/**
 * 取得 Voice 清單
 * GET /voices
 */
async function getVoices() {
  const client = createClient();
  const response = await client.get('/voices');
  return response.data;
}

/**
 * 取得單一 Voice 詳情
 * GET /voices/{voice_id}
 */
async function getVoice(voiceId) {
  const client = createClient();
  const response = await client.get(`/voices/${voiceId}`);
  return response.data;
}

// ==================== Presentation API ====================

/**
 * 產生單次 Presentation
 * POST /presentation
 *
 * @param {Object} options - 選項
 * @param {string} options.avatar_id - Avatar ID (必填)
 * @param {string} options.message - 要呈現的文字 (必填)
 * @param {string} [options.voice_id] - Voice ID (選填)
 * @param {string} [options.emotion] - 情緒選項
 * @param {number} [options.intensity] - 強度 0-1
 */
async function createPresentation({ avatar_id, message, voice_id, emotion, intensity }) {
  const client = createClient();
  const payload = {
    avatar_id,
    message
  };

  if (voice_id) payload.voice_id = voice_id;
  if (emotion) payload.emotion = emotion;
  if (intensity !== undefined) payload.intensity = intensity;

  const response = await client.post('/presentation', payload);
  return response.data;
}

// ==================== Chatbot APIs ====================

/**
 * 取得 Chatbot 清單
 * GET /chatbots
 */
async function getChatbots() {
  const client = createClient();
  const response = await client.get('/chatbots');
  return response.data;
}

/**
 * 建立 Chatbot
 * POST /chatbots
 */
async function createChatbot({ name, model, system_prompt, knowledge_ids }) {
  const client = createClient();
  const payload = { name, model, system_prompt };
  if (knowledge_ids) payload.knowledge_ids = knowledge_ids;

  const response = await client.post('/chatbots', payload);
  return response.data;
}

/**
 * 傳送訊息給 Chatbot
 * POST /chatbots/{chatbot_id}/chat
 *
 * @param {string} chatbotId - Chatbot ID
 * @param {Array} parts - 訊息歷史 (Connect parts 格式)
 * @param {boolean} [stream] - 是否串流回應
 */
async function chatWithChatbot(chatbotId, parts, stream = false) {
  const client = createClient();
  const payload = { parts };
  if (stream) payload.stream = true;

  const response = await client.post(`/chatbots/${chatbotId}/chat`, payload);
  return response.data;
}

// ==================== Voice Token API ====================

/**
 * 取得 TTS Token
 * POST /voice-tokens/tts
 */
async function getVoiceToken({ voice_id, text, format }) {
  const client = createClient();
  const payload = { voice_id, text };
  if (format) payload.format = format;

  const response = await client.post('/voice-tokens/tts', payload);
  return response.data;
}

// ==================== Helper Functions ====================

/**
 * 取得發布用的 Publishable Key
 * 注意：這應該由後端伺服器提供，不應該前端直接呼叫
 */
function getPublishableKey() {
  // 實際應該從後端 /api/connect-key 取得
  // 這裡只是回傳環境變數參考
  return process.env.PERXONA_CONNECT_PUBLISHABLE_KEY || null;
}

module.exports = {
  // Catalog
  getAvatars,
  getAvatar,
  getAvatarMotions,
  getScenes,
  getVoices,
  getVoice,

  // Presentation
  createPresentation,

  // Chatbot
  getChatbots,
  createChatbot,
  chatWithChatbot,

  // Voice Token
  getVoiceToken,

  // Helper
  getPublishableKey
};
