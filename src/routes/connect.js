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
  createPresentation,
  getPublishableKey
} = require('../services/perxona');
const config = require('../../config/default.json');

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
  res.json({
    presenterUrl: 'https://cdn.perxona.ai/prod/latest/widget/entry/presenter.js',
    region: 'asia'
  });
});

router.get('/connect-key', (req, res) => {
  const publishableKey = getPublishableKey();
  if (!publishableKey) {
    res.json({ connectKey: process.env.PERXONA_CONNECT_KEY });
  } else {
    res.json({ connectKey: publishableKey });
  }
});

router.get('/avatars', async (req, res) => {
  try {
    if (cache.avatars && isCacheValid()) {
      return res.json(cache.avatars);
    }
    const data = await getAvatars();
    cache.avatars = data;
    if (!cache.lastFetch) cache.lastFetch = Date.now();
    res.json(data);
  } catch (error) {
    console.error('Error fetching avatars:', error.message);
    res.status(500).json({ error: '無法取得 Avatar 清單' });
  }
});

router.get('/scenes', async (req, res) => {
  try {
    if (cache.scenes && isCacheValid()) {
      return res.json(cache.scenes);
    }
    const data = await getScenes();
    cache.scenes = data;
    if (!cache.lastFetch) cache.lastFetch = Date.now();
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
    if (!cache.lastFetch) cache.lastFetch = Date.now();
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
