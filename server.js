const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadEnv();

const PORT = Number(process.env.PORT || 5174);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 8;

const sessions = new Map();
const generationHits = new Map();

const categories = [
  ['random', 'Quiz au hasard'],
  ['nouveau_testament', 'Nouveau Testament'],
  ['ancien_testament', 'Ancien Testament'],
  ['pentateuque', 'Pentateuque'],
  ['livres_historiques', 'Livres historiques'],
  ['livres_poetiques', 'Livres poetiques'],
  ['livres_prophetiques', 'Livres prophetiques'],
  ['evangiles', 'Evangiles'],
  ['actes', 'Actes des Apotres'],
  ['epitres', 'Epitres'],
  ['apocalypse', 'Apocalypse'],
  ['vie_des_prophetes', 'Vie des prophetes'],
  ['personnages', 'Personnages bibliques'],
  ['actions_personnages', 'Oeuvres / actions des personnages'],
  ['nom_personnage', 'Nom et personnage'],
  ['identification_avancee', 'Identification avancee'],
  ['contexte_historique', 'Bible d etude / contexte historique']
].map(([id, label]) => ({ id, label }));

const levels = [
  ['debutant', 'Debutant'],
  ['intermediaire', 'Intermediaire'],
  ['avance', 'Avance'],
  ['expert', 'Expert']
].map(([id, label]) => ({ id, label }));

const questionTypes = [
  'qcm',
  'vrai_faux',
  'personnage',
  'livre_biblique',
  'completer_verset',
  'associer',
  'epoque_empire',
  'indice_progressif',
  'qui_suis_je',
  'contexte_historique',
  'comprehension_spirituelle'
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: 'Erreur serveur', detail: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Quiz Bible listening on http://localhost:${PORT}`);
});

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/meta') {
    sendJson(res, 200, { categories, levels, questionTypes, appBaseUrl: process.env.APP_BASE_URL || '' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/questions') {
    const questions = readJson('questions.json').filter((q) => q.isActive !== false);
    sendJson(res, 200, { questions });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/challenges') {
    const challenges = readJson('challenges.json').filter((c) => c.isActive !== false);
    sendJson(res, 200, { challenges });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
    const leaderboard = readJson('leaderboard.json')
      .sort((a, b) => b.score - a.score || new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 50);
    sendJson(res, 200, { leaderboard });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/start-game') {
    const body = await readBody(req);
    const count = clamp(Number(body.count || 10), 5, 20);
    const selected = selectQuestions(body.category, body.level, count);
    sendJson(res, 200, { questions: selected.map(withoutAnswer) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/check-answer') {
    const body = await readBody(req);
    const checked = checkSingleAnswer(body);
    if (!checked) {
      sendJson(res, 404, { error: 'Question introuvable' });
      return;
    }
    sendJson(res, 200, checked);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/submit-game') {
    const body = await readBody(req);
    const result = scoreGame(body);
    appendJson('sessions.json', result.session);
    appendJson('leaderboard.json', result.leaderboard);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/generate-questions') {
    if (!rateLimit(req)) {
      sendJson(res, 429, { error: 'Trop de generations. Reessayez dans une minute.' });
      return;
    }
    const body = await readBody(req);
    const questions = await generateQuestions(body);
    sendJson(res, 200, { questions });
    return;
  }

  if (url.pathname === '/api/rooms' && req.method === 'GET') {
    const rooms = readJson('rooms.json').filter((room) => room.isPublic && ['waiting', 'active'].includes(room.status) && new Date(room.endDate) > new Date());
    sendJson(res, 200, { rooms: rooms.map(withRoomCounts) });
    return;
  }

  if (url.pathname === '/api/rooms' && req.method === 'POST') {
    const room = sanitizeRoom(await readBody(req));
    const rooms = readJson('rooms.json');
    room.id = `room-${crypto.randomUUID()}`;
    room.creatorId = room.creatorId || `creator-${crypto.randomUUID()}`;
    room.accessCode = room.accessCode || createAccessCode(rooms);
    room.status = new Date(room.startDate) <= new Date() ? 'active' : 'waiting';
    room.createdAt = new Date().toISOString();
    rooms.push(room);
    writeJson('rooms.json', rooms);
    sendJson(res, 201, { room: withRoomCounts(room) });
    return;
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (roomMatch && req.method === 'GET') {
    const room = findRoom(decodeURIComponent(roomMatch[1]), url.searchParams.get('code'));
    if (!room) return sendJson(res, 404, { error: 'Salon introuvable' });
    sendJson(res, 200, { room: withRoomDetails(room) });
    return;
  }

  const roomStateMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/state$/);
  if (roomStateMatch && req.method === 'GET') {
    const room = findRoom(decodeURIComponent(roomStateMatch[1]), url.searchParams.get('code'));
    if (!room) return sendJson(res, 404, { error: 'Salon introuvable ou code invalide' });
    sendJson(res, 200, buildRoomState(room, url.searchParams.get('participantId')));
    return;
  }

  const roomActionMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(join|leave|start-round|current-round|leaderboard|close)$/);
  if (roomActionMatch) {
    await handleRoomAction(req, res, roomActionMatch, url);
    return;
  }

  const roundAnswerMatch = url.pathname.match(/^\/api\/rounds\/([^/]+)\/answer$/);
  if (roundAnswerMatch && req.method === 'POST') {
    const result = submitRoundAnswer(decodeURIComponent(roundAnswerMatch[1]), await readBody(req));
    if (result.error) return sendJson(res, result.status || 400, { error: result.error });
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === '/api/ai/generate-round-questions' && req.method === 'POST') {
    if (!rateLimit(req)) return sendJson(res, 429, { error: 'Trop de generations. Reessayez dans une minute.' });
    const result = await generateRoundQuestions(await readBody(req));
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === '/api/ai/validate-questions' && req.method === 'POST') {
    const body = await readBody(req);
    const result = await validateQuestionsWithAI(body.questions || [], body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    const body = await readBody(req);
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'change-me';
    if (safeEqual(String(body.username || ''), username) && safeEqual(String(body.password || ''), password)) {
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { createdAt: Date.now(), username });
      res.setHeader('Set-Cookie', `qb_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 401, { error: 'Identifiants invalides' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
    const token = getCookie(req, 'qb_session');
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'qb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname.startsWith('/api/admin/')) {
    if (!isAdmin(req)) {
      sendJson(res, 401, { error: 'Connexion admin requise' });
      return;
    }
    await handleAdminApi(req, res, url);
    return;
  }

  sendJson(res, 404, { error: 'Route introuvable' });
}

async function handleAdminApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/admin/dashboard') {
    sendJson(res, 200, {
      questions: readJson('questions.json'),
      challenges: readJson('challenges.json'),
      sessions: readJson('sessions.json'),
      leaderboard: readJson('leaderboard.json'),
      rooms: readJson('rooms.json').map(withRoomCounts),
      roomParticipants: readJson('roomParticipants.json'),
      rounds: readJson('rounds.json'),
      roundQuestions: readJson('roundQuestions.json'),
      answers: readJson('answers.json'),
      aiErrors: readJson('aiErrors.json'),
      categories,
      levels
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/questions') {
    const body = sanitizeQuestion(await readBody(req));
    const questions = readJson('questions.json');
    body.id = body.id || `q-${crypto.randomUUID()}`;
    body.createdAt = body.createdAt || new Date().toISOString();
    questions.push(body);
    writeJson('questions.json', questions);
    sendJson(res, 201, { question: body });
    return;
  }

  const questionMatch = url.pathname.match(/^\/api\/admin\/questions\/([^/]+)$/);
  if (questionMatch && req.method === 'PUT') {
    const id = decodeURIComponent(questionMatch[1]);
    const body = sanitizeQuestion(await readBody(req));
    const questions = readJson('questions.json');
    const index = questions.findIndex((q) => q.id === id);
    if (index === -1) return sendJson(res, 404, { error: 'Question introuvable' });
    questions[index] = { ...questions[index], ...body, id };
    writeJson('questions.json', questions);
    sendJson(res, 200, { question: questions[index] });
    return;
  }

  if (questionMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(questionMatch[1]);
    writeJson('questions.json', readJson('questions.json').filter((q) => q.id !== id));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/challenges') {
    const body = sanitizeChallenge(await readBody(req));
    const challenges = readJson('challenges.json');
    body.id = body.id || `ch-${crypto.randomUUID()}`;
    body.createdAt = body.createdAt || new Date().toISOString();
    challenges.push(body);
    writeJson('challenges.json', challenges);
    sendJson(res, 201, { challenge: body });
    return;
  }

  const challengeMatch = url.pathname.match(/^\/api\/admin\/challenges\/([^/]+)$/);
  if (challengeMatch && req.method === 'PUT') {
    const id = decodeURIComponent(challengeMatch[1]);
    const body = sanitizeChallenge(await readBody(req));
    const challenges = readJson('challenges.json');
    const index = challenges.findIndex((c) => c.id === id);
    if (index === -1) return sendJson(res, 404, { error: 'Challenge introuvable' });
    challenges[index] = { ...challenges[index], ...body, id };
    writeJson('challenges.json', challenges);
    sendJson(res, 200, { challenge: challenges[index] });
    return;
  }

  if (challengeMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(challengeMatch[1]);
    writeJson('challenges.json', readJson('challenges.json').filter((c) => c.id !== id));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/generate-questions') {
    const body = await readBody(req);
    const generated = await generateQuestions({ ...body, count: body.count || 20 });
    const questions = readJson('questions.json');
    const saved = generated.map((q) => sanitizeQuestion({ ...q, id: q.id || `q-${crypto.randomUUID()}`, isActive: true, createdAt: new Date().toISOString() }));
    writeJson('questions.json', questions.concat(saved));
    sendJson(res, 200, { questions: saved });
    return;
  }

  const adminRoomMatch = url.pathname.match(/^\/api\/admin\/rooms\/([^/]+)\/(close|delete|regenerate)$/);
  if (adminRoomMatch) {
    const id = decodeURIComponent(adminRoomMatch[1]);
    const action = adminRoomMatch[2];
    if (action === 'close' && req.method === 'POST') {
      const room = updateRoomStatus(id, 'closed');
      if (!room) return sendJson(res, 404, { error: 'Salon introuvable' });
      sendJson(res, 200, { room });
      return;
    }
    if (action === 'delete' && req.method === 'DELETE') {
      deleteRoom(id);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === 'regenerate' && req.method === 'POST') {
      const room = readJson('rooms.json').find((item) => item.id === id);
      if (!room) return sendJson(res, 404, { error: 'Salon introuvable' });
      const round = latestRoundForRoom(id) || createRound(room);
      const generated = await createQuestionsForRound(room, round);
      sendJson(res, 200, { round: readJson('rounds.json').find((item) => item.id === round.id) || round, questions: generated });
      return;
    }
  }

  sendJson(res, 404, { error: 'Route admin introuvable' });
}

async function handleRoomAction(req, res, match, url) {
  const roomId = decodeURIComponent(match[1]);
  const action = match[2];
  const code = url.searchParams.get('code');
  const room = findRoom(roomId, code);
  if (!room) return sendJson(res, 404, { error: 'Salon introuvable ou code invalide' });

  if (action === 'join' && req.method === 'POST') {
    const body = await readBody(req);
    const participant = joinRoom(room, body);
    sendJson(res, 200, { participant, room: withRoomDetails(room) });
    return;
  }

  if (action === 'leave' && req.method === 'POST') {
    const body = await readBody(req);
    const participant = leaveRoom(room.id, body.participantId);
    if (!participant) return sendJson(res, 404, { error: 'Participant introuvable' });
    sendJson(res, 200, { participant });
    return;
  }

  if (action === 'start-round' && req.method === 'POST') {
    const body = await readBody(req);
    const allowed = body.creatorId === room.creatorId || isAdmin(req);
    if (!allowed) return sendJson(res, 403, { error: 'Createur ou admin requis' });
    const round = createRound(room, 'starting');
    const questions = await createQuestionsForRound(room, round);
    sendJson(res, 201, buildRoomState(findRoom(room.id, code), body.participantId));
    return;
  }

  if (action === 'current-round' && req.method === 'GET') {
    const round = currentRoundForRoom(room.id);
    if (!round) return sendJson(res, 200, { round: null, questions: [] });
    const questions = readJson('roundQuestions.json')
      .filter((question) => question.roundId === round.id)
      .sort((a, b) => a.order - b.order)
      .map(withoutRoundAnswer);
    sendJson(res, 200, { round, questions });
    return;
  }

  if (action === 'leaderboard' && req.method === 'GET') {
    sendJson(res, 200, { leaderboard: roomLeaderboard(room.id) });
    return;
  }

  if (action === 'close' && req.method === 'POST') {
    const body = await readBody(req);
    const allowed = body.creatorId === room.creatorId || isAdmin(req);
    if (!allowed) return sendJson(res, 403, { error: 'Createur ou admin requis' });
    const closed = updateRoomStatus(room.id, 'closed');
    sendJson(res, 200, { room: closed });
    return;
  }

  sendJson(res, 404, { error: 'Action salon introuvable' });
}

function sanitizeRoom(body) {
  const now = new Date();
  const defaultStart = body.startDate ? new Date(body.startDate) : now;
  const defaultEnd = body.endDate ? new Date(body.endDate) : new Date(defaultStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    id: sanitizeString(body.id || '').slice(0, 80),
    name: sanitizeString(body.name || 'Salon biblique').slice(0, 120),
    description: sanitizeString(body.description || '').slice(0, 500),
    category: sanitizeString(body.category || 'random').slice(0, 80),
    difficulty: sanitizeString(body.difficulty || body.level || 'intermediaire').slice(0, 80),
    creatorId: sanitizeString(body.creatorId || '').slice(0, 100),
    accessCode: sanitizeString(body.accessCode || '').slice(0, 24).toUpperCase(),
    isPublic: body.isPublic !== false,
    status: ['waiting', 'starting', 'question_active', 'question_reveal', 'between_questions', 'closed', 'finished'].includes(body.status) ? body.status : 'waiting',
    startDate: defaultStart.toISOString(),
    endDate: defaultEnd > defaultStart ? defaultEnd.toISOString() : new Date(defaultStart.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    questionTimeLimit: clamp(Number(body.questionTimeLimit || 30), 15, 60),
    roundTimeLimit: clamp(Number(body.roundTimeLimit || 30), 5, 120),
    questionsPerRound: clamp(Number(body.questionsPerRound || 10), 1, 20),
    questionMode: body.questionMode === 'personalized' ? 'personalized' : 'same',
    questionTypes: Array.isArray(body.questionTypes) && body.questionTypes.length
      ? body.questionTypes.filter((type) => questionTypes.includes(type)).slice(0, 8)
      : ['qcm', 'vrai_faux', 'personnage'],
    explanationsEnabled: body.explanationsEnabled !== false,
    questionSource: body.questionSource === 'local' ? 'local' : 'ai',
    createdAt: body.createdAt || new Date().toISOString()
  };
}

function withRoomCounts(room) {
  const participants = readJson('roomParticipants.json').filter((item) => item.roomId === room.id && !item.leftAt);
  const rounds = readJson('rounds.json').filter((item) => item.roomId === room.id);
  return { ...room, participantCount: participants.length, roundCount: rounds.length };
}

function withRoomDetails(room) {
  return {
    ...withRoomCounts(room),
    participants: readJson('roomParticipants.json').filter((item) => item.roomId === room.id && !item.leftAt),
    rounds: readJson('rounds.json').filter((item) => item.roomId === room.id).sort((a, b) => a.roundNumber - b.roundNumber)
  };
}

function findRoom(idOrCode, code) {
  const rooms = readJson('rooms.json');
  const normalized = sanitizeString(idOrCode).toUpperCase();
  const room = rooms.find((item) => item.id === idOrCode || item.accessCode === normalized);
  if (!room) return null;
  if (!room.isPublic && code && room.accessCode !== sanitizeString(code).toUpperCase()) return null;
  if (!room.isPublic && !code && room.id !== idOrCode && room.accessCode !== normalized) return null;
  return refreshRoomStatus(room);
}

function refreshRoomStatus(room) {
  if (['closed', 'finished', 'starting', 'question_active', 'question_reveal', 'between_questions'].includes(room.status)) return room;
  const now = new Date();
  const status = now > new Date(room.endDate) ? 'finished' : 'waiting';
  if (room.status !== status) {
    const rooms = readJson('rooms.json');
    const index = rooms.findIndex((item) => item.id === room.id);
    if (index !== -1) {
      rooms[index] = { ...rooms[index], status };
      writeJson('rooms.json', rooms);
    }
    return { ...room, status };
  }
  return room;
}

function joinRoom(room, body) {
  const participants = readJson('roomParticipants.json');
  const existing = body.participantId && participants.find((item) => item.id === body.participantId && item.roomId === room.id);
  if (existing) {
    existing.leftAt = null;
    writeJson('roomParticipants.json', participants);
    return existing;
  }
  const participant = {
    id: `rp-${crypto.randomUUID()}`,
    roomId: room.id,
    playerName: sanitizeString(body.playerName || 'Anonyme').slice(0, 40) || 'Anonyme',
    joinedAt: new Date().toISOString(),
    leftAt: null,
    totalScore: 0,
    roundsPlayed: 0
  };
  participants.push(participant);
  writeJson('roomParticipants.json', participants);
  return participant;
}

function leaveRoom(roomId, participantId) {
  const participants = readJson('roomParticipants.json');
  const participant = participants.find((item) => item.id === participantId && item.roomId === roomId);
  if (!participant) return null;
  participant.leftAt = new Date().toISOString();
  writeJson('roomParticipants.json', participants);
  return participant;
}

function createRound(room, phase = 'starting') {
  const rounds = readJson('rounds.json');
  const roomRounds = rounds.filter((item) => item.roomId === room.id);
  const startsAt = new Date();
  const firstQuestionAt = new Date(startsAt.getTime() + 2000);
  const round = {
    id: `round-${crypto.randomUUID()}`,
    roomId: room.id,
    roundNumber: roomRounds.length + 1,
    status: 'active',
    phase,
    currentQuestionIndex: 0,
    questionStartedAt: null,
    questionEndsAt: null,
    revealUntil: null,
    nextQuestionAt: firstQuestionAt.toISOString(),
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + room.roundTimeLimit * 60 * 1000).toISOString(),
    generatedByAI: azureConfigured(),
    validationStatus: 'pending',
    createdAt: startsAt.toISOString()
  };
  rounds.push(round);
  writeJson('rounds.json', rounds);
  updateRoomStatus(room.id, phase);
  return round;
}

function currentRoundForRoom(roomId) {
  advanceRoomState(roomId);
  return readJson('rounds.json')
    .filter((round) => round.roomId === roomId && round.status === 'active')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function latestRoundForRoom(roomId) {
  return readJson('rounds.json')
    .filter((round) => round.roomId === roomId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function finishRound(roundId) {
  const rounds = readJson('rounds.json');
  const round = rounds.find((item) => item.id === roundId);
  if (!round) return null;
  round.status = 'finished';
  round.phase = 'finished';
  writeJson('rounds.json', rounds);
  updateRoomStatus(round.roomId, 'finished');
  return round;
}

function advanceRoomState(roomId) {
  const rooms = readJson('rooms.json');
  const room = rooms.find((item) => item.id === roomId);
  if (!room || ['closed', 'finished'].includes(room.status)) return;
  let rounds = readJson('rounds.json');
  const round = rounds
    .filter((item) => item.roomId === roomId && item.status === 'active')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (!round) {
    updateRoomStatus(roomId, 'waiting');
    return;
  }

  const questions = readJson('roundQuestions.json')
    .filter((question) => question.roundId === round.id)
    .sort((a, b) => a.order - b.order);
  const now = Date.now();

  if (now > new Date(round.endsAt).getTime()) {
    finalizeCurrentQuestion(room, round, questions);
    finishRound(round.id);
    return;
  }

  if (round.phase === 'starting' && now >= new Date(round.nextQuestionAt).getTime()) {
    setRoundPhase(round.id, {
      phase: 'question_active',
      questionStartedAt: new Date(now).toISOString(),
      questionEndsAt: new Date(now + room.questionTimeLimit * 1000).toISOString(),
      revealUntil: null,
      nextQuestionAt: null
    });
    updateRoomStatus(roomId, 'question_active');
    return;
  }

  if (round.phase === 'question_active' && now >= new Date(round.questionEndsAt).getTime()) {
    finalizeCurrentQuestion(room, round, questions);
    setRoundPhase(round.id, {
      phase: 'question_reveal',
      revealUntil: new Date(now + 4000).toISOString(),
      nextQuestionAt: new Date(now + 5000).toISOString()
    });
    updateRoomStatus(roomId, 'question_reveal');
    return;
  }

  if (round.phase === 'question_reveal' && now >= new Date(round.revealUntil).getTime()) {
    setRoundPhase(round.id, { phase: 'between_questions' });
    updateRoomStatus(roomId, 'between_questions');
    return;
  }

  if (round.phase === 'between_questions' && now >= new Date(round.nextQuestionAt).getTime()) {
    const nextIndex = Number(round.currentQuestionIndex || 0) + 1;
    if (nextIndex >= questions.length) {
      finishRound(round.id);
      return;
    }
    setRoundPhase(round.id, {
      phase: 'question_active',
      currentQuestionIndex: nextIndex,
      questionStartedAt: new Date(now).toISOString(),
      questionEndsAt: new Date(now + room.questionTimeLimit * 1000).toISOString(),
      revealUntil: null,
      nextQuestionAt: null
    });
    updateRoomStatus(roomId, 'question_active');
  }
}

function setRoundPhase(roundId, patch) {
  const rounds = readJson('rounds.json');
  const round = rounds.find((item) => item.id === roundId);
  if (!round) return null;
  Object.assign(round, patch);
  writeJson('rounds.json', rounds);
  return round;
}

function finalizeCurrentQuestion(room, round, questions) {
  const question = questions[Number(round.currentQuestionIndex || 0)];
  if (!question) return;
  const answers = readJson('answers.json');
  let changed = false;
  for (const answer of answers.filter((item) => item.roundId === round.id && item.questionId === question.id && !item.isFinalized)) {
    const isCorrect = normalize(answer.selectedAnswer) === normalize(question.correctAnswer);
    const questionTimeLimitMs = room.questionTimeLimit * 1000;
    const remaining = Math.max(0, questionTimeLimitMs - Number(answer.responseTimeMs || 0));
    answer.isCorrect = isCorrect;
    answer.basePoints = isCorrect ? 10 : 0;
    answer.speedBonus = isCorrect ? Math.round(10 * remaining / questionTimeLimitMs) : 0;
    answer.totalPoints = answer.basePoints + answer.speedBonus;
    answer.isFinalized = true;
    changed = true;
  }
  if (changed) writeJson('answers.json', answers);
  recalculateParticipantScores(room.id);
}

async function createQuestionsForRound(room, round) {
  const roundQuestions = readJson('roundQuestions.json').filter((item) => item.roundId !== round.id);
  const generated = await generateRoundQuestions({
    roomId: room.id,
    roundId: round.id,
    category: room.category,
    difficulty: room.difficulty,
    count: room.questionsPerRound,
    questionTypes: room.questionTypes || ['qcm', 'vrai_faux', 'personnage'],
    questionSource: room.questionSource || 'ai',
    recentQuestions: recentRoomQuestionTexts(room.id)
  });
  const saved = generated.questions.map((question, index) => sanitizeRoundQuestion({
    ...question,
    id: `rq-${crypto.randomUUID()}`,
    roundId: round.id,
    category: question.category || room.category,
    difficulty: question.difficulty || question.level || room.difficulty,
    order: index + 1
  }));
  writeJson('roundQuestions.json', roundQuestions.concat(saved));
  setRoundValidation(round.id, generated.validationStatus || 'validated');
  return saved;
}

async function generateRoundQuestions(input) {
  const count = clamp(Number(input.count || 10), 1, 20);
  if (input.questionSource === 'local') {
    return {
      questions: selectQuestions(input.category, input.difficulty || input.level, count).map((question) => ({
        ...question,
        difficulty: question.level,
        aiValidationStatus: 'local_selected',
        aiValidationNotes: 'Question locale choisie pour le salon'
      })),
      validationStatus: 'local_selected',
      validation: { results: [] }
    };
  }
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let generated = [];
    try {
      generated = await generateCompetitionQuestions(input, count);
    } catch (error) {
      lastError = `Tentative ${attempt}: ${error.message}`;
      logAiError('generate-round-questions', lastError);
      continue;
    }
    const validation = await validateQuestionsWithAI(generated, input);
    const validQuestions = generated.filter((question, index) => validation.results[index]?.valid && !isRecentDuplicate(question, input.recentQuestions || []));
    if (validQuestions.length >= count) {
      return { questions: validQuestions.slice(0, count), validationStatus: 'validated', validation };
    }
    lastError = `Tentative ${attempt}: ${validQuestions.length}/${count} questions valides`;
  }
  logAiError('generate-round-questions', lastError || 'Generation incomplete');
  return {
    questions: selectQuestions(input.category, input.difficulty || input.level, count).map((question) => ({
      ...question,
      difficulty: question.level,
      aiValidationStatus: 'fallback_local',
      aiValidationNotes: 'Question locale de secours'
    })),
    validationStatus: 'fallback_local',
    validation: { results: [] }
  };
}

async function generateCompetitionQuestions(input, count) {
  if (!azureConfigured()) {
    return selectQuestions(input.category, input.difficulty || input.level, count).map((question) => ({
      ...question,
      difficulty: question.level,
      justification: 'Fallback local'
    }));
  }
  const payload = await callAzureJson([
    {
      role: 'system',
      content: 'Tu es un generateur expert de quiz biblique pour une competition. Genere des questions adaptees a la categorie, au niveau de difficulte et au type de challenge. Chaque question doit avoir une seule bonne reponse, quatre options plausibles, une explication courte et une reference biblique quand possible. Evite les debats doctrinaux. Retourne uniquement du JSON valide.'
    },
    {
      role: 'user',
      content: JSON.stringify({
        category: input.category,
        difficulty: input.difficulty || input.level,
        challengeType: input.challengeType || 'competition',
        count,
        participantLevel: input.participantLevel || null,
        recentQuestions: input.recentQuestions || [],
        output: {
          questions: [{
            question: 'string',
            type: 'qcm',
            options: ['string', 'string', 'string', 'string'],
            correctAnswer: 'string',
            explanation: 'string',
            reference: 'string',
            level: input.difficulty || input.level,
            category: input.category,
            justification: 'string'
          }]
        }
      })
    }
  ]);
  return (Array.isArray(payload.questions) ? payload.questions : []).map((question) => sanitizeQuestion({
    ...question,
    level: question.level || question.difficulty || input.difficulty,
    category: question.category || input.category,
    isActive: true
  })).filter(validateQuestion);
}

async function validateQuestionsWithAI(questions, input = {}) {
  const localResults = questions.map((question) => {
    const valid = validateQuestion(sanitizeQuestion(question)) && !isRecentDuplicate(question, input.recentQuestions || []);
    return {
      valid,
      reason: valid ? 'Validation locale OK' : 'Question invalide, ambigue ou doublon recent',
      correctedQuestion: null
    };
  });
  if (!azureConfigured() || !questions.length) {
    return { results: localResults, source: 'local' };
  }
  try {
    const payload = await callAzureJson([
      {
        role: 'system',
        content: 'Tu es un validateur de qualite pour un quiz biblique. Analyse chaque question et verifie qu elle est claire, non ambigue, bibliquement coherente, adaptee au niveau demande, avec une seule bonne reponse. Retourne pour chaque question : valid true/false, reason, correctedQuestion si necessaire.'
      },
      { role: 'user', content: JSON.stringify({ questions, difficulty: input.difficulty || input.level, category: input.category }) }
    ]);
    const results = Array.isArray(payload.results) ? payload.results : Array.isArray(payload.questions) ? payload.questions : [];
    return { results: questions.map((_, index) => ({
      valid: Boolean(results[index]?.valid) && localResults[index].valid,
      reason: sanitizeString(results[index]?.reason || localResults[index].reason).slice(0, 300),
      correctedQuestion: results[index]?.correctedQuestion || null
    })), source: 'azure' };
  } catch (error) {
    logAiError('validate-questions', error.message);
    return { results: localResults, source: 'local_after_error' };
  }
}

async function callAzureJson(messages) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '');
  const deployment = encodeURIComponent(process.env.AZURE_OPENAI_DEPLOYMENT);
  const apiVersion = encodeURIComponent(process.env.AZURE_OPENAI_API_VERSION);
  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.AZURE_OPENAI_API_KEY },
    body: JSON.stringify({ messages, temperature: 0.45, response_format: { type: 'json_object' } })
  });
  if (!response.ok) throw new Error(`Azure OpenAI HTTP ${response.status}`);
  const payload = await response.json();
  return JSON.parse(payload.choices?.[0]?.message?.content || '{}');
}

function sanitizeRoundQuestion(body) {
  const question = sanitizeQuestion(body);
  return {
    id: body.id || `rq-${crypto.randomUUID()}`,
    roundId: sanitizeString(body.roundId || '').slice(0, 100),
    question: question.question,
    type: question.type,
    options: question.options,
    correctAnswer: question.correctAnswer,
    explanation: question.explanation,
    reference: question.reference,
    category: question.category,
    difficulty: sanitizeString(body.difficulty || question.level).slice(0, 80),
    aiValidationStatus: sanitizeString(body.aiValidationStatus || 'validated').slice(0, 80),
    aiValidationNotes: sanitizeString(body.aiValidationNotes || body.justification || '').slice(0, 300),
    order: Number(body.order || 0)
  };
}

function withoutRoundAnswer(question) {
  const { correctAnswer, ...safe } = question;
  return safe;
}

function submitRoundAnswer(roundId, body) {
  const initialRound = readJson('rounds.json').find((item) => item.id === roundId);
  if (initialRound) advanceRoomState(initialRound.roomId);
  const round = readJson('rounds.json').find((item) => item.id === roundId);
  if (!round) return { error: 'Tour introuvable', status: 404 };
  if (round.status !== 'active' || round.phase !== 'question_active') return { error: 'Les reponses sont fermees pour cette phase', status: 409 };
  const questions = readJson('roundQuestions.json')
    .filter((item) => item.roundId === roundId)
    .sort((a, b) => a.order - b.order);
  const question = questions[Number(round.currentQuestionIndex || 0)];
  if (!question || question.id !== body.questionId) return { error: 'Question non active', status: 409 };
  if (!question) return { error: 'Question introuvable', status: 404 };
  const participants = readJson('roomParticipants.json');
  const participant = participants.find((item) => item.id === body.participantId && item.roomId === round.roomId && !item.leftAt);
  if (!participant) return { error: 'Participant introuvable', status: 404 };
  const answers = readJson('answers.json');
  if (answers.some((answer) => answer.roundId === roundId && answer.questionId === question.id && answer.participantId === participant.id)) {
    return { accepted: true, alreadyAnswered: true, state: buildRoomState(readJson('rooms.json').find((item) => item.id === round.roomId), participant.id) };
  }
  const responseTimeMs = clamp(Date.now() - new Date(round.questionStartedAt).getTime(), 0, 60 * 1000);
  const selectedAnswer = sanitizeString(body.selectedAnswer || '').slice(0, 180);
  const answer = {
    id: `ans-${crypto.randomUUID()}`,
    roundId,
    questionId: question.id,
    participantId: participant.id,
    selectedAnswer,
    isCorrect: false,
    responseTimeMs,
    basePoints: 0,
    speedBonus: 0,
    totalPoints: 0,
    isFinalized: false,
    answeredAt: new Date().toISOString()
  };
  answers.push(answer);
  writeJson('answers.json', answers);
  return {
    accepted: true,
    answer,
    state: buildRoomState(readJson('rooms.json').find((item) => item.id === round.roomId), participant.id)
  };
}

function recalculateParticipantScores(roomId) {
  const participants = readJson('roomParticipants.json');
  const rounds = readJson('rounds.json').filter((round) => round.roomId === roomId).map((round) => round.id);
  const answers = readJson('answers.json').filter((answer) => rounds.includes(answer.roundId));
  for (const participant of participants.filter((item) => item.roomId === roomId)) {
    const participantAnswers = answers.filter((answer) => answer.participantId === participant.id);
    participant.totalScore = participantAnswers.reduce((sum, answer) => sum + answer.totalPoints, 0);
    participant.roundsPlayed = new Set(participantAnswers.map((answer) => answer.roundId)).size;
  }
  writeJson('roomParticipants.json', participants);
}

function buildRoomState(roomInput, participantId) {
  if (!roomInput) return null;
  advanceRoomState(roomInput.id);
  const room = readJson('rooms.json').find((item) => item.id === roomInput.id) || roomInput;
  const participants = readJson('roomParticipants.json').filter((item) => item.roomId === room.id && !item.leftAt);
  const participant = participants.find((item) => item.id === participantId) || null;
  const round = currentRoundForRoom(room.id);
  const questions = round
    ? readJson('roundQuestions.json').filter((item) => item.roundId === round.id).sort((a, b) => a.order - b.order)
    : [];
  const currentQuestion = round ? questions[Number(round.currentQuestionIndex || 0)] : null;
  const answers = readJson('answers.json');
  const currentAnswer = round && currentQuestion && participant
    ? answers.find((item) => item.roundId === round.id && item.questionId === currentQuestion.id && item.participantId === participant.id)
    : null;
  const now = Date.now();
  const phase = round?.phase || room.status || 'waiting';
  const timeRemainingMs = timeRemainingForPhase(round, phase, now);
  const countdownSeconds = Math.max(0, Math.ceil(timeRemainingMs / 1000));
  const revealQuestion = ['question_reveal', 'between_questions', 'finished'].includes(phase);
  const safeQuestion = currentQuestion ? {
    id: currentQuestion.id,
    question: currentQuestion.question,
    type: currentQuestion.type,
    options: currentQuestion.options,
    explanation: revealQuestion && room.explanationsEnabled !== false ? currentQuestion.explanation : undefined,
    reference: revealQuestion ? currentQuestion.reference : undefined,
    correctAnswer: revealQuestion ? currentQuestion.correctAnswer : undefined
  } : null;
  return {
    room: withRoomDetails(room),
    participant,
    participants,
    round,
    phase,
    currentQuestion: safeQuestion,
    currentAnswer: currentAnswer ? {
      selectedAnswer: currentAnswer.selectedAnswer,
      isFinalized: currentAnswer.isFinalized,
      totalPoints: currentAnswer.totalPoints,
      isCorrect: currentAnswer.isCorrect
    } : null,
    timeRemainingMs,
    countdownSeconds,
    score: participant?.totalScore || 0,
    leaderboard: roomLeaderboard(room.id),
    questionIndex: round ? Number(round.currentQuestionIndex || 0) : 0,
    totalQuestions: questions.length
  };
}

function timeRemainingForPhase(round, phase, now) {
  if (!round) return 0;
  if (phase === 'starting' && round.nextQuestionAt) return Math.max(0, new Date(round.nextQuestionAt).getTime() - now);
  if (phase === 'question_active' && round.questionEndsAt) return Math.max(0, new Date(round.questionEndsAt).getTime() - now);
  if (phase === 'question_reveal' && round.revealUntil) return Math.max(0, new Date(round.revealUntil).getTime() - now);
  if (phase === 'between_questions' && round.nextQuestionAt) return Math.max(0, new Date(round.nextQuestionAt).getTime() - now);
  return 0;
}

function roomLeaderboard(roomId) {
  recalculateParticipantScores(roomId);
  return readJson('roomParticipants.json')
    .filter((item) => item.roomId === roomId && !item.leftAt)
    .sort((a, b) => b.totalScore - a.totalScore || a.joinedAt.localeCompare(b.joinedAt))
    .map((item, index) => ({ rank: index + 1, ...item }));
}

function updateRoomStatus(roomId, status) {
  const rooms = readJson('rooms.json');
  const room = rooms.find((item) => item.id === roomId);
  if (!room) return null;
  room.status = status;
  writeJson('rooms.json', rooms);
  return room;
}

function setRoundValidation(roundId, validationStatus) {
  const rounds = readJson('rounds.json');
  const round = rounds.find((item) => item.id === roundId);
  if (round) {
    round.validationStatus = validationStatus;
    writeJson('rounds.json', rounds);
  }
}

function deleteRoom(roomId) {
  writeJson('rooms.json', readJson('rooms.json').filter((item) => item.id !== roomId));
  writeJson('roomParticipants.json', readJson('roomParticipants.json').filter((item) => item.roomId !== roomId));
  const roundIds = readJson('rounds.json').filter((item) => item.roomId === roomId).map((round) => round.id);
  writeJson('rounds.json', readJson('rounds.json').filter((item) => item.roomId !== roomId));
  writeJson('roundQuestions.json', readJson('roundQuestions.json').filter((item) => !roundIds.includes(item.roundId)));
  writeJson('answers.json', readJson('answers.json').filter((item) => !roundIds.includes(item.roundId)));
}

function recentRoomQuestionTexts(roomId) {
  const roundIds = readJson('rounds.json').filter((round) => round.roomId === roomId).map((round) => round.id);
  return readJson('roundQuestions.json')
    .filter((question) => roundIds.includes(question.roundId))
    .slice(-80)
    .map((question) => question.question);
}

function isRecentDuplicate(question, recentQuestions) {
  const text = normalize(question.question || '');
  return recentQuestions.some((recent) => normalize(recent) === text);
}

function logAiError(scope, message) {
  appendJson('aiErrors.json', {
    id: `aie-${crypto.randomUUID()}`,
    scope,
    message: sanitizeString(message || 'Erreur IA').slice(0, 500),
    createdAt: new Date().toISOString()
  });
}

function createAccessCode(existingRooms = readJson('rooms.json')) {
  const used = new Set(existingRooms.map((room) => room.accessCode));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = `BIBLE-${crypto.randomInt(100, 1000)}`;
    if (!used.has(code)) return code;
  }
  return `BIBLE-${crypto.randomInt(1000, 10000)}`;
}

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), `${JSON.stringify(data, null, 2)}\n`);
}

function appendJson(file, item) {
  const data = readJson(file);
  data.push(item);
  writeJson(file, data);
}

function serveStatic(req, res, pathname) {
  const cleanPath = pathname === '/' || pathname === '/admin' ? '/index.html' : pathname;
  const fullPath = path.normalize(path.join(PUBLIC_DIR, cleanPath));
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(fullPath, (error, content) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (fallbackError, fallback) => {
        if (fallbackError) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fallback);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType(fullPath) });
    res.end(content);
  });
}

function contentType(file) {
  const ext = path.extname(file);
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg'
  }[ext] || 'application/octet-stream';
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('JSON invalide'));
      }
    });
  });
}

function selectQuestions(category, level, count) {
  const questions = readJson('questions.json').filter((q) => q.isActive !== false);
  const filtered = questions.filter((q) => {
    const categoryOk = !category || category === 'random' || q.category === category || broadCategoryMatch(category, q.category);
    const levelOk = !level || q.level === level;
    return categoryOk && levelOk;
  });
  const pool = filtered.length >= count ? filtered : questions;
  return shuffle(pool).slice(0, count);
}

function broadCategoryMatch(category, questionCategory) {
  if (category === 'ancien_testament') {
    return ['pentateuque', 'livres_historiques', 'livres_poetiques', 'livres_prophetiques', 'vie_des_prophetes', 'contexte_historique'].includes(questionCategory);
  }
  if (category === 'nouveau_testament') {
    return ['evangiles', 'actes', 'epitres', 'apocalypse'].includes(questionCategory);
  }
  return false;
}

function withoutAnswer(question) {
  const { correctAnswer, ...safe } = question;
  return safe;
}

function scoreGame(body) {
  const answers = Array.isArray(body.answers) ? body.answers : [];
  const questions = readJson('questions.json');
  let score = 0;
  let correctAnswers = 0;
  const review = answers.map((answer) => {
    const question = questions.find((q) => q.id === answer.questionId);
    if (!question) return null;
    const isCorrect = normalize(answer.answer) === normalize(question.correctAnswer);
    const timeLeft = Number(answer.timeLeft || 0);
    const timeLimit = Number(answer.timeLimit || body.timeLimit || 30);
    const bonus = isCorrect ? clamp(Math.ceil((timeLeft / Math.max(timeLimit, 1)) * 5), 0, 5) : 0;
    if (isCorrect) {
      correctAnswers += 1;
      score += 10 + bonus;
    }
    return {
      questionId: question.id,
      question: question.question,
      answer: sanitizeString(answer.answer),
      correctAnswer: question.correctAnswer,
      isCorrect,
      points: isCorrect ? 10 + bonus : 0,
      explanation: question.explanation,
      reference: question.reference
    };
  }).filter(Boolean);
  const totalQuestions = review.length;
  const percent = totalQuestions ? Math.round((correctAnswers / totalQuestions) * 100) : 0;
  const levelEstimate = percent >= 90 ? 'Expert' : percent >= 75 ? 'Avance' : percent >= 55 ? 'Intermediaire' : 'Debutant';
  const createdAt = new Date().toISOString();
  const playerName = sanitizeString(body.playerName || 'Anonyme').slice(0, 40) || 'Anonyme';
  const session = {
    id: `gs-${crypto.randomUUID()}`,
    playerName,
    category: sanitizeString(body.category || 'random'),
    level: sanitizeString(body.level || 'debutant'),
    score,
    totalQuestions,
    correctAnswers,
    duration: Number(body.duration || 0),
    createdAt
  };
  return {
    session,
    leaderboard: {
      id: `lb-${crypto.randomUUID()}`,
      playerName,
      score,
      category: session.category,
      level: session.level,
      createdAt
    },
    review,
    percent,
    levelEstimate,
    encouragement: encouragement(percent),
    recommendations: recommendations(percent, session.category)
  };
}

function checkSingleAnswer(body) {
  const question = readJson('questions.json').find((q) => q.id === body.questionId);
  if (!question) return null;
  const isCorrect = normalize(body.answer) === normalize(question.correctAnswer);
  const timeLeft = Number(body.timeLeft || 0);
  const timeLimit = Number(body.timeLimit || 30);
  const bonus = isCorrect ? clamp(Math.ceil((timeLeft / Math.max(timeLimit, 1)) * 5), 0, 5) : 0;
  return {
    questionId: question.id,
    question: question.question,
    answer: sanitizeString(body.answer),
    correctAnswer: question.correctAnswer,
    isCorrect,
    points: isCorrect ? 10 + bonus : 0,
    explanation: question.explanation,
    reference: question.reference
  };
}

async function generateQuestions(input) {
  const category = validId(input.category, categories, 'random');
  const level = validId(input.level, levels, 'debutant');
  const count = clamp(Number(input.count || 10), 1, 20);
  const requestedTypes = Array.isArray(input.questionTypes) && input.questionTypes.length
    ? input.questionTypes.filter((type) => questionTypes.includes(type))
    : ['qcm', 'vrai_faux', 'personnage'];

  if (!azureConfigured()) {
    return selectQuestions(category, level, count).map((q) => ({ ...q, source: 'fallback_local' }));
  }

  const prompt = {
    category,
    level,
    count,
    questionTypes: requestedTypes,
    outputShape: {
      questions: [{
        id: 'string',
        question: 'string',
        type: 'qcm',
        options: ['string', 'string', 'string', 'string'],
        correctAnswer: 'string',
        explanation: 'string',
        reference: 'string',
        difficulty: level,
        category
      }]
    }
  };

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '');
  const deployment = encodeURIComponent(process.env.AZURE_OPENAI_DEPLOYMENT);
  const apiVersion = encodeURIComponent(process.env.AZURE_OPENAI_API_VERSION);
  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.AZURE_OPENAI_API_KEY
    },
    body: JSON.stringify({
      messages: [
        {
          role: 'system',
          content: 'Tu es un generateur de quiz biblique pedagogique. Genere uniquement des questions bibliques fiables, claires, non ambigues, avec une bonne reponse exacte, des distracteurs plausibles, une explication courte et une reference biblique si possible. Ne genere pas de doctrine controversee comme verite absolue. Pour les questions historiques, distingue clairement le texte biblique du contexte historique issu des Bibles d etude. Reponds uniquement en JSON valide.'
        },
        { role: 'user', content: JSON.stringify(prompt) }
      ],
      temperature: 0.5,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    return selectQuestions(category, level, count).map((q) => ({ ...q, source: 'fallback_local' }));
  }

  const payload = await response.json();
  const text = payload.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  const generated = Array.isArray(parsed.questions) ? parsed.questions : [];
  const valid = generated.map((q) => sanitizeQuestion({
    ...q,
    id: q.id || `q-${crypto.randomUUID()}`,
    level: q.level || q.difficulty || level,
    category: q.category || category,
    isActive: true,
    createdAt: new Date().toISOString()
  })).filter(validateQuestion);
  return valid.length ? valid.slice(0, count) : selectQuestions(category, level, count).map((q) => ({ ...q, source: 'fallback_local' }));
}

function azureConfigured() {
  return Boolean(
    process.env.AZURE_OPENAI_ENDPOINT &&
    process.env.AZURE_OPENAI_API_KEY &&
    process.env.AZURE_OPENAI_DEPLOYMENT &&
    process.env.AZURE_OPENAI_API_VERSION
  );
}

function sanitizeQuestion(body) {
  const options = Array.isArray(body.options) ? body.options.map((v) => sanitizeString(v).slice(0, 180)).filter(Boolean) : [];
  return {
    id: sanitizeString(body.id || '').slice(0, 80),
    question: sanitizeString(body.question || '').slice(0, 500),
    type: questionTypes.includes(body.type) ? body.type : 'qcm',
    options: options.length ? options : ['Vrai', 'Faux'],
    correctAnswer: sanitizeString(body.correctAnswer || '').slice(0, 180),
    explanation: sanitizeString(body.explanation || '').slice(0, 700),
    reference: sanitizeString(body.reference || '').slice(0, 120),
    category: sanitizeString(body.category || 'random').slice(0, 80),
    level: sanitizeString(body.level || body.difficulty || 'debutant').slice(0, 80),
    isActive: body.isActive !== false,
    createdAt: body.createdAt || new Date().toISOString()
  };
}

function validateQuestion(question) {
  if (!question.question || !question.correctAnswer || !question.explanation) return false;
  if (!Array.isArray(question.options) || question.options.length < 2) return false;
  if (!question.options.some((option) => normalize(option) === normalize(question.correctAnswer))) return false;
  if (question.type === 'qcm' && question.options.length !== 4) return false;
  return true;
}

function sanitizeChallenge(body) {
  return {
    id: sanitizeString(body.id || '').slice(0, 80),
    title: sanitizeString(body.title || '').slice(0, 160),
    description: sanitizeString(body.description || '').slice(0, 600),
    category: sanitizeString(body.category || 'random').slice(0, 80),
    level: sanitizeString(body.level || 'debutant').slice(0, 80),
    days: clamp(Number(body.days || 7), 1, 30),
    progression: clamp(Number(body.progression || 0), 0, 100),
    summary: sanitizeString(body.summary || '').slice(0, 500),
    isActive: body.isActive !== false,
    createdAt: body.createdAt || new Date().toISOString()
  };
}

function sanitizeString(value) {
  return String(value ?? '').replace(/[<>]/g, '').trim();
}

function normalize(value) {
  return sanitizeString(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.split('=').slice(1).join('=');
}

function isAdmin(req) {
  const token = getCookie(req, 'qb_session');
  const session = token && sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > 8 * 60 * 60 * 1000) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function rateLimit(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const hits = (generationHits.get(ip) || []).filter((time) => now - time < RATE_WINDOW_MS);
  hits.push(now);
  generationHits.set(ip, hits);
  return hits.length <= RATE_MAX;
}

function validId(value, list, fallback) {
  return list.some((item) => item.id === value) ? value : fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function shuffle(items) {
  return [...items].sort(() => Math.random() - 0.5);
}

function encouragement(percent) {
  if (percent >= 90) return 'Excellent parcours. Continue avec les questions de contexte et de memorisation.';
  if (percent >= 75) return 'Tres bon resultat. Quelques details bibliques peuvent encore renforcer ta maitrise.';
  if (percent >= 55) return 'Bonne progression. Revois les references indiquees pour consolider les bases.';
  return 'Continue avec les niveaux debutants et les challenges de 7 jours pour poser des reperes solides.';
}

function recommendations(percent, category) {
  const base = [
    'Relire les references des questions manquees.',
    'Refaire une partie courte avec 5 questions pour memoriser.'
  ];
  if (percent < 70) base.push('Choisir un challenge 7 jours lie a la categorie jouee.');
  if (category === 'contexte_historique') base.push('Distinguer le texte biblique des notes historiques de Bible d etude.');
  return base;
}
