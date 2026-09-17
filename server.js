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
const crypto = require('crypto');

// ---------------- Push notifications (FCM) ----------------
// Optional and self-disabling: if FIREBASE_SERVICE_ACCOUNT_JSON isn't set
// as an environment variable yet, push notifications are simply skipped
// (a warning is logged once) rather than crashing the server. This lets
// the chat itself work immediately, with push added once Firebase is set
// up, without a redeploy-breaking dependency in between.
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

// Admin devices that should receive a push when a customer messages --
// registered via POST /api/admin/fcm-token (the Android app calls this
// once it has a token). A Set so the same device re-registering doesn't
// create duplicates.
//
// Unlike active chat sessions (see the file-header comment -- those are
// deliberately in-memory-only), this Set is mirrored to MantleDB, the
// same simple external key-value store the site and the Android app
// already use for other saved data. Device registrations aren't
// transactional the way a chat session is -- there's no reasonable
// sense in which "the server happened to restart" should make an
// admin's phone stop receiving pushes until they think to reopen the
// Admin tab. Render's free/hobby tier spins the service down after a
// period of inactivity and spins a fresh instance back up on the next
// request, wiping any plain in-memory Set -- which is exactly what
// produced the "push arrives from the 2nd message but never the 1st"
// pattern: the very request that wakes the server (a brand new order)
// finds zero registered devices, because nothing yet had a chance to
// re-register on this fresh instance.
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
// Kicked off later, awaited immediately before the server starts
// accepting connections (see the bottom of this file) -- this used to
// fire immediately here instead, which left a real (if short) window
// where an incoming request could still find zero tokens if it arrived
// before this finished. Not awaiting it before the server opens for
// requests defeats a good chunk of the point of persisting these at all.

async function notifyAdminsOfNewMessage(orderId, customerName, text) {
  if (!fcmEnabled) {
    console.log(`[MOON] Skipping push for order ${orderId} -- FCM not enabled (no FIREBASE_SERVICE_ACCOUNT_JSON).`);
    return;
  }
  if (adminFcmTokens.size === 0) {
    console.log(`[MOON] Skipping push for order ${orderId} -- FCM is enabled but zero admin devices are registered. The Android app must open the admin screen at least once (which calls POST /api/admin/fcm-token) before this can ever succeed.`);
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
      // Without this, FCM's default Android priority is "normal" --
      // several OEM skins (Xiaomi/MIUI, Samsung, Huawei among them)
      // will delay or drop a normal-priority push entirely once the
      // device is in Doze / the app is backgrounded, which is exactly
      // the "notification never arrives" symptom this addresses.
      // channelId matches MoonFirebaseMessagingService's channel so a
      // notification delivered while the app is fully killed (which
      // bypasses onMessageReceived and is drawn by the OS directly from
      // this payload) still lands in the same channel as one shown from
      // the foreground path, instead of a default/fallback channel.
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
    // Prune tokens the device itself has invalidated (uninstalled app,
    // token rotated, etc.) so the set doesn't grow with dead entries.
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
// Render sits in front of this app as a reverse proxy -- without this,
// req.ip would be Render's own internal proxy address on every request,
// not the actual visitor's IP.
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
// Socket.io defaults to a 1MB max payload per packet, which a busy
// photo can occasionally exceed and every video attachment definitely
// does (the site caps raw video at 12MB, which becomes ~16MB once
// base64-encoded for transport) -- packets over the limit are dropped
// silently rather than reaching send_message's handler at all. 20MB
// gives that headroom without leaving the limit effectively unbounded.
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 20 * 1024 * 1024 });

// orderId -> { customer, order, messages: [...], status: 'active'|'completed', createdAt }
const sessions = new Map();

function publicSession(orderId, session) {
  return {
    orderId,
    customer: session.customer,
    order: session.order,
    messages: session.messages,
    status: session.status,
    createdAt: session.createdAt,
    // Meant for the admin's own view only -- the site decides not to
    // render these for the customer's own chat, the same soft
    // trust-the-frontend model every other role-gated action here
    // already relies on (there's no per-role auth at this layer).
    customerIp: session.customerIp || null,
    customerLocation: session.customerLocation || null
  };
}

// Best-effort IP -> approximate city/region lookup via a free, no-signup
// API. This is NOT precise location -- there's no GPS-level accuracy to
// be had from an IP address at all, only a rough city/ISP-level guess,
// and it can be wrong entirely for a mobile carrier, corporate network,
// or anyone on a VPN. A support-side hint, never something to rely on.
async function lookupIpLocation(ip){
  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,isp`);
    const data = await res.json();
    if (!data || data.status !== 'success') return null;
    return { country: data.country || '', region: data.regionName || '', city: data.city || '', isp: data.isp || '' };
  } catch(e) {
    return null;
  }
}

// ---------------- REST ----------------

// Called by the site the moment a customer places an order (any of the
// site's 5 order types -- main download, weekly/monthly subscription,
// paid edit, cheap package). This is the direct replacement for
// building a wa.me/t.me link.
app.post('/api/sessions', (req, res) => {
  const { orderId, customer, order, firstMessage } = req.body;
  if (!orderId || !customer) {
    return res.status(400).json({ error: 'orderId and customer are required' });
  }
  const messages = [];
  if (firstMessage) {
    messages.push(Object.assign({}, firstMessage, {
      id: (typeof firstMessage.id === 'string' && firstMessage.id) ? firstMessage.id.slice(0, 100) : crypto.randomUUID()
    }));
  }
  // Auto-reply -- fires the instant a new order comes in, before any
  // human on the admin side has even seen it, so the customer gets
  // immediate acknowledgement instead of a silent wait. Sent as
  // from: 'admin' (not a separate 'system' role) since the messenger UI
  // only ever styles two senders; this reads correctly as "the shop"
  // having replied, which is what it actually is.
  if (firstMessage) {
    messages.push({
      id: crypto.randomUUID(),
      from: 'admin',
      text: 'ჩვენო ძვირფასო მომხმარებელო, ადმინისტრატორი მალე ნახავს თქვენს შეკვეთას ❤️ მანამდე გთხოვთ აირჩიოთ გადახდის მეთოდი და როცა გადახდას განახორციელებთ სასურველია დამადასტურებელი სქრინშოთი გამოაგზავნოთ❤️',
      ts: Date.now() + 1 // +1ms so it always sorts strictly after firstMessage even on same-millisecond creation
    });
  }
  const session = {
    customer, // { discordId, username, avatarUrl }
    order,    // { type, tiktok, price, details, ... } -- whatever the site already built for the old WA/TG message text
    messages,
    status: 'active',
    createdAt: Date.now(),
    customerIp: req.ip || null,
    customerLocation: null // filled in below, once the lookup resolves
  };
  sessions.set(orderId, session);
  io.to('admin_room').emit('new_session', publicSession(orderId, session));
  // Without this, the FIRST message of a new order (this one, embedded
  // in session creation) never triggered a push at all -- only messages
  // sent afterward via the send_message socket handler did. That made it
  // look like push "only works starting from the second message," when
  // really the very first one was just never wired to notifyAdminsOfNewMessage.
  if (firstMessage) {
    notifyAdminsOfNewMessage(orderId, customer?.username, firstMessage.text || '');
  }
  res.json({ ok: true, orderId });

  // Fired after the response above, not awaited by it -- the admin's
  // support-side location hint is a nice-to-have, never something the
  // customer should be kept waiting on. If it resolves before the admin
  // opens the chat, GET /api/sessions/:orderId already has it; if the
  // admin's already looking at the chat, join_admin's room just doesn't
  // get a live update for it (a reload picks it up).
  if (session.customerIp) {
    lookupIpLocation(session.customerIp).then(loc => {
      const s = sessions.get(orderId);
      if (s) s.customerLocation = loc;
    }).catch(() => {});
  }
});

// Looked up right after Discord login (and on page load, if already
// logged in) so a customer who closes the chat -- or leaves and comes
// back later, even on a different device -- can get straight back into
// it instead of it just vanishing. Declared BEFORE /api/sessions/:orderId
// below, since Express would otherwise match "by-customer" as if it
// were an :orderId value.
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

// Customer's own "Cancel order" button on the site calls this directly
// (as a fallback/complement to the cancel_order socket event below, in
// case the socket round-trip doesn't land before the tab reloads).
// Actually removes the session rather than just marking it inactive --
// a cancelled order has nothing worth keeping, and the site is relying
// on this to make /api/sessions/by-customer stop finding it so the
// "you have an active chat" bubble doesn't just bring the same
// "cancelled" chat right back on the next page load. Idempotent:
// deleting an orderId that's already gone (or never existed) is not an
// error, same as calling this twice in a row from a flaky connection.
app.delete('/api/sessions/:orderId', (req, res) => {
  const existed = sessions.delete(req.params.orderId);
  res.json({ ok: true, existed });
});

// Admin panel / Android app: list every currently-active chat.
app.get('/api/sessions', (req, res) => {
  const active = [];
  for (const [orderId, session] of sessions.entries()) {
    if (session.status === 'active') active.push(publicSession(orderId, session));
  }
  active.sort((a, b) => b.createdAt - a.createdAt);
  res.json(active);
});

app.get('/health', (req, res) => res.json({ ok: true, activeSessions: sessions.size, fcmEnabled, registeredAdminDevices: adminFcmTokens.size }));

// Called once by the Android admin app after it obtains its FCM
// registration token, so a new customer message can reach the admin's
// phone even while the app is backgrounded or the site tab is closed.
app.post('/api/admin/fcm-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });
  const isNew = !adminFcmTokens.has(token);
  adminFcmTokens.add(token);
  console.log(`[MOON] FCM token ${isNew ? 'registered' : 're-registered'} (...${token.slice(-12)}). Total devices: ${adminFcmTokens.size}. fcmEnabled=${fcmEnabled}`);
  if (isNew) persistFcmTokens();
  res.json({ ok: true, fcmEnabled });
});

// ---------------- Socket.io ----------------

// Tells the room who's currently connected as which role, whenever that
// changes (a join or a disconnect) -- powers the site's online-status
// dot. Presence is tracked per session rather than globally since "is
// the admin online" only means anything in the context of one specific
// order's room.
function broadcastPresence(orderId) {
  const session = sessions.get(orderId);
  if (!session || !session.presence) return;
  io.to(orderId).emit('presence', {
    adminOnline: session.presence.admin.size > 0,
    customerOnline: session.presence.customer.size > 0
  });
}

io.on('connection', (socket) => {
  socket.on('join_order', ({ orderId, role }) => {
    if (!orderId || !sessions.has(orderId)) return;
    socket.join(orderId);
    socket.data.orderId = orderId;
    socket.data.role = role === 'admin' ? 'admin' : 'customer';
    const session = sessions.get(orderId);
    if (!session.presence) session.presence = { admin: new Set(), customer: new Set() };
    session.presence[socket.data.role].add(socket.id);
    broadcastPresence(orderId);
  });

  // The admin panel (site or Android app) joins this room once to
  // receive "a new order came in" / "a customer replied" notifications
  // for every session, without needing to join each order room
  // individually.
  socket.on('join_admin', () => {
    socket.join('admin_room');
  });

  socket.on('send_message', ({ orderId, message }) => {
    const session = sessions.get(orderId);
    if (!session || session.status !== 'active' || !message) return;
    const stored = {
      id: (typeof message.id === 'string' && message.id) ? message.id.slice(0, 100) : crypto.randomUUID(),
      from: message.from, // 'customer' | 'admin'
      text: String(message.text || '').slice(0, 2000),
      ts: Date.now()
    };
    // Photos/videos travel as data: URLs from the site (photos already
    // downsized client-side; video capped hard at 12MB raw, since this
    // server keeps every session in plain memory with no database
    // behind it -- see MESSENGER_VIDEO_MAX_BYTES on the site side).
    // Passed through as-is, unlike text: slicing a base64 string at an
    // arbitrary character count would corrupt it into something that
    // can no longer decode as an image/video at all. The startsWith
    // checks are a cheap sanity check, not real validation -- just
    // enough to stop a stray non-data-URL string from being stored as
    // if it were a real attachment.
    if (typeof message.image === 'string' && message.image.startsWith('data:image/')) {
      stored.image = message.image;
    }
    if (typeof message.video === 'string' && message.video.startsWith('data:video/')) {
      stored.video = message.video;
    }
    // A small reference to the quoted message only (id + a short text
    // preview + who sent it) -- never the replied-to message's own
    // image/video, so quoting a photo doesn't double the payload size
    // of every reply to it.
    if (message.replyTo && typeof message.replyTo === 'object' && message.replyTo.id) {
      stored.replyTo = {
        id: String(message.replyTo.id),
        from: message.replyTo.from === 'admin' ? 'admin' : 'customer',
        preview: String(message.replyTo.preview || '').slice(0, 200)
      };
    }
    session.messages.push(stored);
    io.to(orderId).emit('new_message', stored);
    // Lets the admin side show an unread badge / trigger a push
    // notification even if it hasn't opened this specific order's room.
    io.to('admin_room').emit('admin_notify', {
      orderId,
      message: stored,
      customer: session.customer
    });
    // Real push (FCM), for when the admin app is backgrounded or the
    // site tab is closed entirely -- the socket-based admin_notify above
    // only reaches a currently-open tab/app. Only fires for customer
    // messages; the admin doesn't need a push for their own reply.
    if (stored.from === 'customer') {
      notifyAdminsOfNewMessage(orderId, session.customer?.username, stored.text || (stored.image ? '📷 ფოტო' : stored.video ? '🎥 ვიდეო' : ''));
    }
  });

  // Admin panel's "Complete order" button -- closes the chat and tells
  // the customer's tab to return to the homepage.
  socket.on('complete_order', ({ orderId }) => {
    const session = sessions.get(orderId);
    if (!session) return;
    session.status = 'completed';
    io.to(orderId).emit('order_completed');
  });

  // Customer's own "Cancel order" button. Unlike complete_order above,
  // this deletes the session outright rather than just changing its
  // status -- there's nothing worth keeping about a cancelled order,
  // and the site depends on the session actually being gone so it stops
  // turning up in /api/sessions/by-customer on the customer's next page
  // load. Same trust model as complete_order: whichever side is
  // connected to this room can call this; the site is what's
  // responsible for only exposing the button to the customer.
  socket.on('cancel_order', ({ orderId }) => {
    if (!orderId || !sessions.has(orderId)) return;
    sessions.delete(orderId);
    io.to(orderId).emit('order_cancelled');
  });

  // Long-press "Delete" on a message bubble. Only removes a message
  // whose stored `from` matches the `from` the request claims to be
  // deleting as -- same soft trust model as everything else here (there's
  // no real auth layer at the socket level), but this at least stops one
  // side's UI from being able to silently delete the other side's
  // message by id if it somehow got hold of it.
  socket.on('delete_message', ({ orderId, messageId, from }) => {
    const session = sessions.get(orderId);
    if (!session || !messageId) return;
    const idx = session.messages.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    if (session.messages[idx].from !== from) return;
    session.messages.splice(idx, 1);
    io.to(orderId).emit('message_deleted', { messageId });
  });

  // Typing indicator: relayed to everyone else in the room (never back
  // to the sender) with no server-side state kept at all -- the site
  // handles its own auto-hide-after-a-few-seconds timing, so there's
  // nothing here that needs an explicit stop_typing counterpart.
  socket.on('typing', ({ orderId }) => {
    if (!orderId || !socket.data.role) return;
    socket.to(orderId).emit('typing', { from: socket.data.role });
  });

  // Read receipt: records when this role last had the chat open/visible,
  // and tells the other side so it can mark its own latest message as
  // seen. Only the timestamp is kept (not a per-message flag) -- exactly
  // like most chat apps, "seen" is a single high-water mark, not a
  // separate receipt per message.
  socket.on('mark_read', ({ orderId }) => {
    const session = sessions.get(orderId);
    if (!session || !socket.data.role) return;
    session.lastRead = session.lastRead || {};
    session.lastRead[socket.data.role] = Date.now();
    socket.to(orderId).emit('read_receipt', { from: socket.data.role, ts: session.lastRead[socket.data.role] });
  });

  // Reactions: one emoji per person per message, same as most chat
  // apps -- tapping the same emoji again removes it, picking a
  // different one replaces whichever this person had before. Stored on
  // the message itself so it's part of the normal history fetch with no
  // separate lookup needed.
  socket.on('react_message', ({ orderId, messageId, emoji }) => {
    const session = sessions.get(orderId);
    if (!session || !messageId || !emoji || !socket.data.role) return;
    const msg = session.messages.find(m => m.id === messageId);
    if (!msg) return;
    msg.reactions = msg.reactions || {};
    if (msg.reactions[socket.data.role] === emoji) {
      delete msg.reactions[socket.data.role];
    } else {
      msg.reactions[socket.data.role] = emoji;
    }
    io.to(orderId).emit('message_reacted', { messageId, reactions: msg.reactions });
  });

  // Cleans up presence so a closed tab/app doesn't leave a stale
  // "online" dot showing on the other side -- the same join/leave
  // bookkeeping broadcastPresence relies on, just in reverse.
  socket.on('disconnect', () => {
    const { orderId, role } = socket.data;
    if (!orderId || !role) return;
    const session = sessions.get(orderId);
    if (session && session.presence && session.presence[role]) {
      session.presence[role].delete(socket.id);
      broadcastPresence(orderId);
    }
  });
});

const PORT = process.env.PORT || 3000;
(async () => {
  // Awaited so the server doesn't open for requests -- including the
  // very request that wakes it from a Render free-tier spin-down, which
  // is often a brand new order -- until previously-registered devices
  // are back in adminFcmTokens. See loadPersistedFcmTokens's own comment
  // for why this specific ordering is what the fix actually depends on.
  await loadPersistedFcmTokens();
  server.listen(PORT, () => {
    console.log(`MOON chat server listening on port ${PORT}`);
  });
})();
