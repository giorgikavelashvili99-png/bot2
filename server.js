// MOON -- real-time order chat server.
//
// Replaces WhatsApp/Telegram entirely: when a customer places an order,
// the site creates a session here instead of building a wa.me/t.me deep
// link, then both the customer (on the site) and the admin (on the site
// or the Android app) join the same Socket.io room and exchange
// messages instantly, no page refresh needed.
//
// Deliberately in-memory, no database, no PDF export -- this was scoped
// down on purpose (see project notes) to avoid the operational overhead
// of Firestore for something this size. A restart clears active
// sessions; that's an accepted tradeoff for the simplicity.
//
// Deploy: same place bot2.py already runs (Render.com). This is a
// separate Node service from that Python bot -- they don't share a
// process, only (optionally) the same Render account.

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

// ---------------- Push notifications (FCM) ----------------
let admin = null;
let fcmEnabled = false;
try {
  admin = require('firebase-admin');
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    fcmEnabled = true;
    console.log('[MOON] FCM push notifications enabled.');
  } else {
    console.log('[MOON] FIREBASE_SERVICE_ACCOUNT_JSON not set -- push notifications disabled, chat still works normally.');
  }
} catch (e) {
  console.log('[MOON] firebase-admin not usable yet -- push notifications disabled, chat still works normally.', e.message);
}

const MANTLEDB_BASE = 'https://mantledb.sh/v2';
const MANTLEDB_NAMESPACE = 'moonge-tbilisi-vc7f3q';
const FCM_TOKENS_PATH = 'chat-server-fcm-admin-tokens';
const adminFcmTokens = new Set();

async function loadPersistedFcmTokens() {
  try {
    const resp = await fetch(`${MANTLEDB_BASE}/${MANTLEDB_NAMESPACE}/${FCM_TOKENS_PATH}`);
    if (resp.status === 404) {
      console.log('[MOON] No persisted FCM tokens found yet (first run, or none ever registered).');
      return;
    }
    if (!resp.ok) {
      console.log(`[MOON] Could not load persisted FCM tokens (HTTP ${resp.status}) -- starting with an empty set; devices will need to re-register.`);
      return;
    }
    const data = await resp.json();
    const list = Array.isArray(data.list) ? data.list : [];
    list.forEach(t => adminFcmTokens.add(t));
    console.log(`[MOON] Restored ${list.length} FCM token(s) from persistent storage -- survives this restart, no re-registration needed.`);
  } catch (e) {
    console.log('[MOON] Error loading persisted FCM tokens -- starting with an empty set:', e.message);
  }
}

async function persistFcmTokens() {
  try {
    await fetch(`${MANTLEDB_BASE}/${MANTLEDB_NAMESPACE}/${FCM_TOKENS_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list: Array.from(adminFcmTokens) })
    });
  } catch (e) {
    console.log('[MOON] Error persisting FCM tokens (registration still works for this session, just won\'t survive a restart):', e.message);
  }
}

async function notifyAdminsOfNewMessage(orderId, customerName, text) {
  if (!fcmEnabled) {
    console.log(`[MOON] Skipping push for order ${orderId} -- FCM not enabled (no FIREBASE_SERVICE_ACCOUNT_JSON).`);
    return;
  }
  if (adminFcmTokens.size === 0) {
    console.log(`[MOON] Skipping push for order ${orderId} -- FCM is enabled but zero admin devices are registered.`);
    return;
  }
  const tokens = Array.from(adminFcmTokens);
  console.log(`[MOON] Sending push for order ${orderId} to ${tokens.length} device(s)...`);
  try {
    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title: customerName ? `${customerName} -- შეკვეთა #${orderId}` : `შეკვეთა #${orderId}`,
        body: text.slice(0, 200)
      },
      data: { orderId },
      android: {
        priority: 'high',
        notification: { channelId: 'moon_order_chat' }
      }
    });
    const successCount = resp.responses.filter(r => r.success).length;
    console.log(`[MOON] Push for order ${orderId}: ${successCount}/${tokens.length} delivered to FCM successfully.`);
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        console.log(`[MOON]   device ...${tokens[i].slice(-12)} failed: ${r.error?.code || r.error?.message}`);
      }
    });
    let pruned = false;
    resp.responses.forEach((r, i) => {
      if (!r.success && (r.error?.code === 'messaging/registration-token-not-registered')) {
        adminFcmTokens.delete(tokens[i]);
        pruned = true;
      }
    });
    if (pruned) persistFcmTokens();
  } catch (e) {
    console.log('[MOON] FCM send failed (chat itself is unaffected):', e.message);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const sessions = new Map();

function publicSession(orderId, session) {
  return {
    orderId,
    customer: session.customer,
    order: session.order,
    messages: session.messages,
    status: session.status,
    createdAt: session.createdAt
  };
}

app.post('/api/sessions', (req, res) => {
  const { orderId, customer, order, firstMessage } = req.body;
  if (!orderId || !customer) {
    return res.status(400).json({ error: 'orderId and customer are required' });
  }
  const session = {
    customer,
    order,
    messages: firstMessage ? [firstMessage] : [],
    status: 'active',
    createdAt: Date.now()
  };
  sessions.set(orderId, session);
  io.to('admin_room').emit('new_session', publicSession(orderId, session));
  if (firstMessage) {
    notifyAdminsOfNewMessage(orderId, customer?.username, firstMessage.text || '');
  }
  res.json({ ok: true, orderId });
});

app.get('/api/sessions/by-customer/:discordId', (req, res) => {
  const discordId = req.params.discordId;
  const active = [];
  for (const [orderId, session] of sessions.entries()) {
    if (session.status === 'active' && session.customer?.discordId === discordId) {
      active.push(publicSession(orderId, session));
    }
  }
  active.sort((a, b) => b.createdAt - a.createdAt);
  res.json(active);
});

app.get('/api/sessions/:orderId', (req, res) => {
  const session = sessions.get(req.params.orderId);
  if (!session) return res.status(404).json({ error: 'not found' });
  res.json(publicSession(req.params.orderId, session));
});

app.get('/api/sessions', (req, res) => {
  const active = [];
  for (const [orderId, session] of sessions.entries()) {
    if (session.status === 'active') active.push(publicSession(orderId, session));
  }
  active.sort((a, b) => b.createdAt - a.createdAt);
  res.json(active);
});

app.get('/health', (req, res) => res.json({ ok: true, activeSessions: sessions.size, fcmEnabled, registeredAdminDevices: adminFcmTokens.size }));

app.post('/api/admin/fcm-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });
  const isNew = !adminFcmTokens.has(token);
  adminFcmTokens.add(token);
  console.log(`[MOON] FCM token ${isNew ? 'registered' : 're-registered'} (...${token.slice(-12)}). Total devices: ${adminFcmTokens.size}. fcmEnabled=${fcmEnabled}`);
  if (isNew) persistFcmTokens();
  res.json({ ok: true, fcmEnabled });
});

io.on('connection', (socket) => {
  socket.on('join_order', ({ orderId }) => {
    if (!orderId || !sessions.has(orderId)) return;
    socket.join(orderId);
    socket.data.orderId = orderId;
  });

  socket.on('join_admin', () => {
    socket.join('admin_room');
  });

  socket.on('send_message', ({ orderId, message }) => {
    const session = sessions.get(orderId);
    if (!session || session.status !== 'active' || !message) return;
    const stored = {
      from: message.from,
      text: String(message.text || '').slice(0, 2000),
      ts: Date.now()
    };
    session.messages.push(stored);
    io.to(orderId).emit('new_message', stored);
    io.to('admin_room').emit('admin_notify', {
      orderId,
      message: stored,
      customer: session.customer
    });
    if (stored.from === 'customer') {
      notifyAdminsOfNewMessage(orderId, session.customer?.username, stored.text);
    }
  });

  socket.on('complete_order', ({ orderId }) => {
    const session = sessions.get(orderId);
    if (!session) return;
    session.status = 'completed';
    io.to(orderId).emit('order_completed');
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
(async () => {
  await loadPersistedFcmTokens();
  server.listen(PORT, () => {
    console.log(`MOON chat server listening on port ${PORT}`);
  });
})();
