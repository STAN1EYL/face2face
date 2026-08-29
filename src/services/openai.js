const OpenAI = require('openai');
const config = require('../../config/default.json');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const SYSTEM_PROMPT = `你是 Perxona AI 助手，一個友善且專業的 AI 虛擬助手。請用繁體中文回答問題，保持簡潔和有幫助。`;

async function chat(message, history = []) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: messages,
    temperature: 0.7,
    max_tokens: 500
  });

  return response.choices[0].message.content;
}

module.exports = { chat };
