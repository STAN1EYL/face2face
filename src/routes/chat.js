const express = require('express');
const router = express.Router();
const { chat } = require('../services/openai');
const { synthesize } = require('../services/tts');
const { getSession, updateSession } = require('../utils/session');
const { determineMotion } = require('../services/motion');
const config = require('../../config/default.json');

router.post('/chat', async (req, res) => {
  try {
    // API key validation
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OpenAI API Key 未設定' });
    }

    const { message, sessionId } = req.body;

    if (!message || message.trim() === '') {
      return res.status(400).json({ error: '訊息不能為空' });
    }

    const session = getSession(sessionId || 'default');
    const history = session.history || [];

    const reply = await chat(message, history);

    const newHistory = [
      ...history,
      { role: 'user', content: message },
      { role: 'assistant', content: reply }
    ].slice(-config.openai.maxHistory * 2);

    updateSession(sessionId || 'default', { history: newHistory });

    let audio = null;
    try {
      audio = await synthesize(reply);
    } catch (ttsError) {
      console.error('TTS error:', ttsError);
    }

    const motion = determineMotion(reply);

    res.json({
      reply,
      audio: audio ? `data:audio/mp3;base64,${audio}` : null,
      motion,
      sessionId: sessionId || 'default'
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: '抱歉，發生錯誤，請稍後再試' });
  }
});

module.exports = router;
