const axios = require('axios');
const config = require('../../config/default.json');

const TTS_URL = `https://${process.env.AZURE_TTS_REGION || 'eastus'}.tts.speech.microsoft.com/cognitiveservices/v1`;

async function synthesize(text) {
  const ssml = `
<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-TW'>
  <voice name='${config.azure.tts.voice}'>
    ${text}
  </voice>
</speak>`;

  const response = await axios.post(TTS_URL, ssml, {
    headers: {
      'Ocp-Apim-Subscription-Key': process.env.AZURE_TTS_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': config.azure.tts.outputFormat
    },
    responseType: 'arraybuffer'
  });

  return Buffer.from(response.data).toString('base64');
}

module.exports = { synthesize };
