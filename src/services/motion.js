function determineMotion(text) {
  const lowerText = text.toLowerCase();
  if (lowerText.match(/你好|嗨|hello|hi|早安|晚安|歡迎/)) return 'wave';
  if (lowerText.includes('?')) return 'thinking';
  if (lowerText.match(/對|是的|同意|好|沒問題/)) return 'nod';
  return 'idle';
}

module.exports = { determineMotion };
