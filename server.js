// server.js (hiragana room code + synced SFX + roulette + confetti-on-open)
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use("/img", express.static(path.join(__dirname, "img")));
app.use("/music", express.static(path.join(__dirname, "music")));
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const rooms = new Map();
// phase: lobby -> write -> reveal -> done

const HIRA = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";
function genRoomCode(len = 5) {
  let s = "";
  for (let i = 0; i < len; i++) s += HIRA[Math.floor(Math.random() * HIRA.length)];
  return s;
}
function genId() { return crypto.randomBytes(4).toString("hex"); }

function getRoom(code) {
  const room = rooms.get(code);
  if (!room) throw new Error("ROOM_NOT_FOUND");
  return room;
}
function isHost(room, socket) { return room.hostSocketId === socket.id; }
function ensureAllSubmitted(room) { return room.users.length >= 2 && room.users.every(u => u.submitted); }

function derange(ids) {
  if (ids.length < 2) return null;
  const a = [...ids];
  for (let tries = 0; tries < 300; tries++) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    let ok = true;
    for (let i = 0; i < ids.length; i++) {
      if (a[i] === ids[i]) { ok = false; break; }
    }
    if (ok) return a;
  }
  const b = [...ids];
  const n = b.length;
  [b[n - 1], b[n - 2]] = [b[n - 2], b[n - 1]];
  for (let i = 0; i < ids.length; i++) if (b[i] === ids[i]) return null;
  return b;
}

function currentStep(room) {
  if (room.phase !== "reveal" || !room.reveal) return null;
  const idx = room.reveal.index;
  const p = room.reveal.pairs[idx];
  if (!p) return null;

  const from = room.users.find(u => u.id === p.fromId);
  const to = room.users.find(u => u.id === p.toId);
  if (!from || !to) return null;

  return {
    step: idx + 1,
    total: room.reveal.pairs.length,
    fromName: from.name,
    toName: to.name,
    toId: to.id,
    title: p.title,
    opened: room.reveal.opened,
    startAt: room.reveal.startAt,
    durationMs: room.reveal.durationMs,
  };
}

function serializeRoom(room) {
  return {
    code: room.code,
    hostSocketId: room.hostSocketId,
    phase: room.phase,
    users: room.users.map(u => ({ id: u.id, name: u.name, submitted: !!u.submitted })),
    step: currentStep(room),
  };
}

function broadcast(room) {
  io.to(room.code).emit("room:update", serializeRoom(room));
}

function buildPairs(room) {
  if (!ensureAllSubmitted(room)) throw new Error("WAIT_ALL_DONE");

  const ids = room.users.map(u => u.id);
  const toIds = derange(ids);
  if (!toIds) throw new Error("ASSIGN_FAILED");

  const pairs = ids.map((fromId, i) => {
    const from = room.users.find(u => u.id === fromId);
    const gift = from.gift || {};
    return {
      fromId,
      toId: toIds[i],
      title: String(gift.title || "").trim(),
      body: String(gift.body || "").trim(),
    };
  });

  room.reveal = {
    pairs,
    index: 0,
    opened: false,
    startAt: Date.now() + 250,
    durationMs: 1700,
  };
}

function emitRoulette(room) {
  const step = currentStep(room);
  if (!step) return;
  io.to(room.code).emit("anim:roulette", step);
}

io.on("connection", (socket) => {
  socket.on("room:create", (_payload, cb) => {
    try {
      let code;
      do { code = genRoomCode(5); } while (rooms.has(code));

      rooms.set(code, {
        code,
        hostSocketId: socket.id,
        phase: "lobby",
        users: [],
        reveal: null,
        submitSfxCount: 0,
      });

      cb?.({ ok: true, code });
    } catch (e) { cb?.({ ok: false, error: e.message || String(e) }); }
  });

  socket.on("room:join", ({ code, name }, cb) => {
    try {
      code = String(code || "").trim().normalize("NFC");
      name = String(name || "").trim() || "名無し";

      const room = getRoom(code);
      socket.join(code);

      let user = room.users.find(u => u.socketId === socket.id);
      if (!user) {
        user = { id: genId(), socketId: socket.id, name, submitted: false, gift: null };
        room.users.push(user);
      } else {
        user.name = name;
      }

      cb?.({ ok: true, room: serializeRoom(room), userId: user.id, isHost: isHost(room, socket) });
      broadcast(room);
    } catch (e) { cb?.({ ok: false, error: e.message || String(e) }); }
  });

  socket.on("room:start", ({ code }, cb) => {
    try {
      const room = getRoom(String(code).trim().normalize("NFC"));
      if (!isHost(room, socket)) throw new Error("NOT_HOST");
      if (room.users.length < 2) throw new Error("NEED_2_OR_MORE");

      room.phase = "write";
      room.reveal = null;
      room.submitSfxCount = 0;

      for (const u of room.users) { u.submitted = false; u.gift = null; }

      broadcast(room);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok: false, error: e.message || String(e) }); }
  });

  socket.on("gift:submit", ({ code, userId, title, body }, cb) => {
    try {
      const room = getRoom(String(code).trim().normalize("NFC"));
      if (room.phase !== "write") throw new Error("NOT_IN_WRITE");

      const user = room.users.find(u => u.id === userId);
      if (!user) throw new Error("USER_NOT_FOUND");

      title = String(title || "").trim();
      body = String(body || "").trim();
      if (!title) throw new Error("TITLE_REQUIRED");
      if (!body) throw new Error("BODY_REQUIRED");

      const wasSubmitted = user.submitted;

      user.gift = { title, body };
      user.submitted = true;

      // 1→2→3の順で全員に同じSE
      if (!wasSubmitted) {
        room.submitSfxCount += 1;
        const idx = ((room.submitSfxCount - 1) % 3) + 1;
        io.to(room.code).emit("sfx:submit", { idx });
      }

      broadcast(room);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok: false, error: e.message || String(e) }); }
  });

  socket.on("draw:start", ({ code }, cb) => {
    try {
      const room = getRoom(String(code).trim().normalize("NFC"));
      if (!isHost(room, socket)) throw new Error("NOT_HOST");
      if (!ensureAllSubmitted(room)) throw new Error("WAIT_ALL_DONE");

      room.phase = "reveal";
      buildPairs(room);

      broadcast(room);
      emitRoulette(room);

      cb?.({ ok: true });
    } catch (e) { cb?.({ ok: false, error: e.message || String(e) }); }
  });

  socket.on("reveal:open", ({ code, userId }, cb) => {
    try {
      const room = getRoom(String(code).trim().normalize("NFC"));
      if (room.phase !== "reveal" || !room.reveal) throw new Error("NOT_IN_REVEAL");

      const step = currentStep(room);
      if (!step) throw new Error("NO_STEP");
      if (step.toId !== userId) throw new Error("NOT_RECEIVER");
      if (room.reveal.opened) throw new Error("ALREADY_OPENED");

      room.reveal.opened = true;

      const p = room.reveal.pairs[room.reveal.index];
      const from = room.users.find(u => u.id === p.fromId);
      const to = room.users.find(u => u.id === p.toId);

      // 全員へ「開封された」通知（UI用）
      io.to(room.code).emit("reveal:opened", {
        fromName: from?.name || "?",
        toName: to?.name || "?",
        title: p.title,
        step: room.reveal.index + 1,
        total: room.reveal.pairs.length,
      });

      // 受取人だけ本文を送る
      io.to(to.socketId).emit("reveal:private", {
        fromName: from?.name || "?",
        title: p.title,
        body: p.body,
      });

      // ★追加：全員に「紙吹雪だけ」演出（同期）
      const startAt = Date.now() + 120;                 // 少し先に開始
      const seed = (startAt ^ 0x9e3779b9) >>> 0;        // 32bit seed
      io.to(room.code).emit("fx:confetti", { startAt, seed });

      broadcast(room);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok: false, error: e.message || String(e) }); }
  });

  socket.on("reveal:next", ({ code }, cb) => {
    try {
      const room = getRoom(String(code).trim().normalize("NFC"));
      if (!isHost(room, socket)) throw new Error("NOT_HOST");
      if (room.phase !== "reveal" || !room.reveal) throw new Error("NOT_IN_REVEAL");
      if (!room.reveal.opened) throw new Error("WAIT_OPEN");

      room.reveal.index += 1;

      if (room.reveal.index >= room.reveal.pairs.length) {
        room.phase = "done";
        broadcast(room);
        io.to(room.code).emit("done");
        cb?.({ ok: true });
        return;
      }

      room.reveal.opened = false;
      room.reveal.startAt = Date.now() + 250;
      room.reveal.durationMs = 1700;

      broadcast(room);
      emitRoulette(room);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok: false, error: e.message || String(e) }); }
  });

  socket.on("room:close", ({ code }, cb) => {
    try {
      const room = getRoom(String(code).trim().normalize("NFC"));
      if (!isHost(room, socket)) throw new Error("NOT_HOST");
      io.to(room.code).emit("room:closed");
      rooms.delete(room.code);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok: false, error: e.message || String(e) }); }
  });

  socket.on("room:leave", ({ code, userId }, cb) => {
    try {
      const room = getRoom(String(code).trim().normalize("NFC"));

      if (isHost(room, socket)) {
        io.to(room.code).emit("room:closed");
        rooms.delete(room.code);
        cb?.({ ok: true });
        return;
      }

      room.users = room.users.filter(u => u.id !== userId);
      broadcast(room);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok: false, error: e.message || String(e) }); }
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms.entries()) {
      if (room.hostSocketId === socket.id) {
        io.to(code).emit("room:closed");
        rooms.delete(code);
        continue;
      }
      const before = room.users.length;
      room.users = room.users.filter(u => u.socketId !== socket.id);
      if (room.users.length !== before) broadcast(room);
    }
  });
});

const PORT = 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
