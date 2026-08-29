const { v4: uuidv4 } = require('uuid');

const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, { id, history: [], createdAt: new Date() });
  }
  return sessions.get(id);
}

function updateSession(id, data) {
  const session = getSession(id);
  Object.assign(session, data);
  sessions.set(id, session);
  return session;
}

function createSession() {
  const id = uuidv4();
  return getSession(id);
}

module.exports = { getSession, updateSession, createSession };
