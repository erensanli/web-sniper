import http from 'http';
import fs from 'fs';
import path from 'path';
import tls from 'tls';
import http2 from 'http2';
import WebSocket, { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------- KONFİGÜRASYON ----------------------
const CONFIG = {
  port: 3000,
  token: process.env.DISCORD_TOKEN || '',
  serverId: process.env.SERVER_ID || '',
  channelId: process.env.CHANNEL_ID || '',
  password: process.env.DISCORD_PASSWORD || '',
  gatewayUrl: 'wss://gateway.discord.gg/?v=9&encoding=json',
  webhookUrl: process.env.WEBHOOK_URL || '',
  poolSize: 2
};

const superProperties = 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRmlyZWZveCIsImRldmljZSI6IiIsInN5c3RlbV9sb2NhbGUiOiJ0ci1UUiIsImJyb3dzZXJfdXNlcl9hZ2VudCI6Ik1vemlsbGEvNS4wIChXaW5kb3dzIE5UIDEwLjA7IFdpbjY0OyB4NjQ7IHJ2OjEzMy4wKSBHZWNrby8yMDEwMDEwMSBGaXJlZm94LzEzMy4wIiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTMzLjAiLCJvc192ZXJzaW9uIjoiMTAiLCJyZWZlcnJlciI6Imh0dHBzOi8vd3d3Lmdvb2dsZS5jb20vIiwicmVmZXJyaW5nX2RvbWFpbiI6Ind3dy5nb29nbGUuY29tIiwic2VhcmNoX2VuZ2luZSI6Imdvb2dsZSIsInJlZmVycmVyX2N1cnJlbnQiOiIiLCJyZWxlYXNlX2NoYW5uZWwiOiJjYW5hcnkiLCJjbGllbnRfYnVpbGRfbnVtYmVyIjozNTYxNDAsImNsaWVudF9ldmVudF9zb3VyY2UiOm51bGwsImhhc19jbGllbnRfbW9kcyI6ZmFsc2V9';
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';

// ---------------------- DURUM DEĞİŞKENLERİ ----------------------
let selectedMode = 2; // 1: Hedef, 2: Tüm Sunucular (Al-Dur), 3: Sonsuz
let targetVanityCode = '';
let isLocked = false;
let gatewayReady = false;
let mfaToken = null;
let lastClaim = null; // { code, speed, time }

const guilds = new Map();
const prebuiltBuffers = new Map();
let sessionId = null;
let lastSequence = null;
let resumeGatewayUrl = null;
let heartbeatTimer = null;
let wsDiscord = null;

// ---------------------- WEB SOCKET CLIENT BROADCAST ----------------------
const clients = new Set();

function broadcastState() {
  const payload = JSON.stringify({
    type: 'state',
    trackedCount: guilds.size,
    gatewayReady,
    mfaReady: !!mfaToken,
    isLocked,
    selectedMode,
    targetVanityCode,
    lastClaim
  });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function broadcastLog(tag, level, message) {
  const payload = JSON.stringify({
    type: 'log',
    tag,
    level,
    message
  });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ---------------------- WEBHOOK GÖNDERİCİ ----------------------
async function sendWebhook(claimedCode, elapsed) {
  if (!CONFIG.webhookUrl) return;

  try {
    const imgPath = path.join(__dirname, 'avatar.jpg');
    const formData = new FormData();
    const displayMs = '20ms';
    formData.append('content', `Kayzer Airlines "${claimedCode}" (${displayMs})`);

    if (fs.existsSync(imgPath)) {
      const fileBuffer = fs.readFileSync(imgPath);
      formData.append('file', new Blob([fileBuffer], { type: 'image/jpeg' }), 'avatar.jpg');
    }

    const res = await fetch(CONFIG.webhookUrl, {
      method: 'POST',
      body: formData
    });

    if (res.ok) {
      broadcastLog('WEBHOOK', 'claim', `Bildirim Discord'a atıldı! (${displayMs})`);
    }
  } catch (err) {
    broadcastLog('WEBHOOK', 'error', `Webhook hatası: ${err.message}`);
  }
}

// ---------------------- RAW HTTP HAZIRLAMA ----------------------
function buildRawPatchRequest(vanityCode) {
  const body = JSON.stringify({ code: vanityCode });
  const headers = [
    `PATCH /api/v10/guilds/${CONFIG.serverId}/vanity-url HTTP/1.1`,
    "Host: canary.discord.com",
    `Authorization: ${CONFIG.token}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    `User-Agent: ${userAgent}`,
    `X-Super-Properties: ${superProperties}`,
    mfaToken ? `X-Discord-MFA-Authorization: ${mfaToken}` : null,
    mfaToken ? `Cookie: __Secure-recent_mfa=${mfaToken}` : null,
    "Connection: keep-alive"
  ].filter(Boolean).join("\r\n");

  return Buffer.from(headers + "\r\n\r\n" + body, 'utf-8');
}

function rebuildAllBuffers() {
  for (const code of guilds.values()) {
    if (code) prebuiltBuffers.set(code, buildRawPatchRequest(code));
  }
}

// ---------------------- SICAK TLS SOKET HAVUZU ----------------------
class TLSPool {
  constructor(size = 2) {
    this.size = size;
    this.sockets = [];
    this.initPool();
  }

  initPool() {
    for (let i = 0; i < this.size; i++) {
      this.createSocket(i);
    }
  }

  createSocket(index) {
    if (this.sockets[index]) {
      this.sockets[index].cleanup();
    }

    const socket = tls.connect({
      host: 'canary.discord.com',
      port: 443,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      servername: 'canary.discord.com',
      keepAlive: true,
      rejectUnauthorized: false
    });

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);

    let pingTimer = null;
    let claimTime = null;

    const cleanup = () => {
      clearInterval(pingTimer);
      socket.removeAllListeners();
      try { socket.destroy(); } catch {}
    };

    socket.on('secureConnect', () => {
      pingTimer = setInterval(() => {
        if (socket.writable) {
          socket.write('HEAD / HTTP/1.1\r\nHost: canary.discord.com\r\nConnection: keep-alive\r\n\r\n');
        }
      }, 4000);
    });

    socket.on('data', () => {});
    socket.on('close', () => {
      cleanup();
      setTimeout(() => this.createSocket(index), 1000);
    });
    socket.on('error', () => { cleanup(); });

    this.sockets[index] = {
      socket,
      cleanup,
      setClaimTime: (t) => { claimTime = t; }
    };
  }

  fire(vanityCode) {
    if (isLocked) return;
    const payload = prebuiltBuffers.get(vanityCode) || buildRawPatchRequest(vanityCode);
    const start = process.hrtime.bigint();

    for (const item of this.sockets) {
      if (item.socket && item.socket.writable) {
        item.setClaimTime(start);
        item.socket.write(payload);
      }
    }
  }
}

const tlsPool = new TLSPool(CONFIG.poolSize);

// ---------------------- HTTP/2 SESSION ----------------------
class SessionManager {
  constructor() {
    this.session = null;
    this.connecting = false;
    this.connect();
  }

  connect() {
    if (this.connecting) return;
    this.connecting = true;

    if (this.session && !this.session.destroyed) {
      try { this.session.destroy(); } catch {}
    }

    this.session = http2.connect("https://canary.discord.com", {
      settings: { enablePush: false },
      secureContext: tls.createSecureContext({
        ciphers: 'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256',
        rejectUnauthorized: false
      })
    });

    this.session.on('connect', () => { this.connecting = false; });
    this.session.on('error', () => {
      this.connecting = false;
      setTimeout(() => this.connect(), 2000);
    });
    this.session.on('close', () => {
      this.connecting = false;
      setTimeout(() => this.connect(), 2000);
    });
  }

  async request(method, path, customHeaders = {}, body = null) {
    if (!this.session || this.session.destroyed) {
      this.connect();
      await new Promise(r => setTimeout(r, 600));
    }

    const requestHeaders = {
      ":method": method,
      ":path": path,
      ":authority": "canary.discord.com",
      ":scheme": "https",
      "User-Agent": userAgent,
      "Authorization": CONFIG.token,
      "Content-Type": "application/json",
      "X-Super-Properties": superProperties,
      ...customHeaders
    };

    return new Promise((resolve, reject) => {
      try {
        const stream = this.session.request(requestHeaders);
        const chunks = [];
        stream.on("data", c => chunks.push(c));
        stream.on("end", () => resolve(Buffer.concat(chunks).toString()));
        stream.on("error", reject);
        if (body) stream.end(body);
        else stream.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}

const sessionManager = new SessionManager();

async function refreshMfaToken() {
  if (!CONFIG.password || !CONFIG.serverId) return;

  try {
    const initialResponse = await sessionManager.request("PATCH", `/api/v7/guilds/${CONFIG.serverId}/vanity-url`);
    const data = JSON.parse(initialResponse);

    if (data.code === 60003 && data.mfa?.ticket) {
      const savedTicket = data.mfa.ticket;

      const mfaResponse = await sessionManager.request(
        "POST",
        "/api/v9/mfa/finish",
        { "Content-Type": "application/json" },
        JSON.stringify({
          ticket: savedTicket,
          mfa_type: "password",
          data: CONFIG.password,
        })
      );

      const mfaData = JSON.parse(mfaResponse);
      if (mfaData.token) {
        mfaToken = mfaData.token;
        broadcastLog('MFA', 'system', 'MFA bileti başarıyla güncellendi.');
        rebuildAllBuffers();
        broadcastState();
      }
    } else if (data.token) {
      mfaToken = data.token;
      rebuildAllBuffers();
      broadcastLog('MFA', 'system', 'MFA Token doğrudan alındı.');
      broadcastState();
    }
  } catch {}
}

// ---------------------- DISCORD GATEWAY ----------------------
function initGateway() {
  if (wsDiscord) {
    wsDiscord.removeAllListeners();
    try { wsDiscord.terminate(); } catch {}
  }

  clearInterval(heartbeatTimer);
  const targetUrl = resumeGatewayUrl || CONFIG.gatewayUrl;
  wsDiscord = new WebSocket(targetUrl);

  wsDiscord.on('open', () => {
    broadcastLog('GATEWAY', 'system', 'Discord Gateway açıldı, kimlik doğrulanıyor...');
    if (sessionId && lastSequence !== null) {
      wsDiscord.send(JSON.stringify({
        op: 6,
        d: {
          token: CONFIG.token,
          session_id: sessionId,
          seq: lastSequence
        }
      }));
    } else {
      wsDiscord.send(JSON.stringify({
        op: 2,
        d: {
          token: CONFIG.token,
          intents: 1,
          properties: { os: "linux", browser: "firefox", device: "" },
          zero_rtt: true,
          guild_subscriptions: false,
          large_threshold: 10
        }
      }));
    }
  });

  wsDiscord.on('message', (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (payload.s) lastSequence = payload.s;

    if (payload.t === 'GUILD_UPDATE') {
      const d = payload.d;
      const gid = d.id;
      const next = d.vanity_url_code;
      const prev = guilds.get(gid);

      broadcastLog('RADAR', 'system', `GUILD_UPDATE: ${gid} (eski: ${prev || 'yok'}, yeni: ${next || 'null'})`);

      if (prev && prev !== next) {
        if (selectedMode === 1 && targetVanityCode && prev.toLowerCase() !== targetVanityCode.toLowerCase()) {
          guilds.set(gid, next);
          return;
        }

        if (isLocked) return;

        const start = process.hrtime.bigint();
        tlsPool.fire(prev);
        broadcastLog('RADAR', 'trigger', `Vanity boşa çıktı: "${prev}" — Anında fırlatıldı!`);

        sessionManager.request(
          "PATCH",
          `/api/v10/guilds/${CONFIG.serverId}/vanity-url`,
          {
            "X-Discord-MFA-Authorization": mfaToken,
            "Cookie": mfaToken ? `__Secure-recent_mfa=${mfaToken}` : "",
            "Content-Type": "application/json",
          },
          JSON.stringify({ code: prev })
        ).then((h2Res) => {
          const elapsed = `${(Number(process.hrtime.bigint() - start) / 1e6).toFixed(2)}ms`;
          if (h2Res.includes('"code":') && !h2Res.includes('"message":')) {
            const now = new Date().toLocaleTimeString();
            lastClaim = { code: prev, speed: elapsed, time: now };
            broadcastLog('KAZANILDI', 'claim', `🏆 "${prev}" URL'si kapıldı! (${elapsed})`);
            sendWebhook(prev, elapsed);

            if (selectedMode === 1 || selectedMode === 2) {
              isLocked = true;
              broadcastLog('KİLİT', 'trigger', `Güvenlik Kilidi aktif: Yeni URL'nin üzerine yazılmaması için sniper durduruldu.`);
            }
            broadcastState();
          } else if (h2Res.includes('"retry_after":')) {
            broadcastLog('LIMIT', 'error', `Rate limit uyarısı (${elapsed}): ${h2Res}`);
          }
        }).catch(() => {});

        guilds.set(gid, next);
        return;
      }

      if (next) guilds.set(gid, next);
      return;
    }

    try {
      const payload = JSON.parse(str);
      if (payload.s) lastSequence = payload.s;

      switch (payload.op) {
        case 10: {
          const interval = payload.d.heartbeat_interval;
          heartbeatTimer = setInterval(() => {
            if (wsDiscord && wsDiscord.readyState === WebSocket.OPEN) {
              wsDiscord.send(JSON.stringify({ op: 1, d: lastSequence }));
            }
          }, interval);
          break;
        }

        case 7:
        case 9: {
          const canResume = payload.d;
          if (!canResume) {
            sessionId = null;
            lastSequence = null;
          }
          wsDiscord.close();
          break;
        }

        case 0: {
          if (payload.t === 'READY') {
            sessionId = payload.d.session_id;
            resumeGatewayUrl = payload.d.resume_gateway_url ? `${payload.d.resume_gateway_url}?v=9&encoding=json` : null;
            guilds.clear();
            prebuiltBuffers.clear();

            for (const g of payload.d.guilds) {
              if (g.vanity_url_code) {
                guilds.set(g.id, g.vanity_url_code);
                prebuiltBuffers.set(g.vanity_url_code, buildRawPatchRequest(g.vanity_url_code));
              }
            }

            gatewayReady = true;
            broadcastLog('READY', 'claim', `Giriş başarılı! Radar aktif: ${guilds.size} vanity izleniyor.`);
            refreshMfaToken();
            broadcastState();
          } else if (payload.t === 'RESUMED') {
            gatewayReady = true;
            broadcastLog('GATEWAY', 'system', 'Oturum kesintisiz devam ettirildi (RESUMED).');
            broadcastState();
          }
          break;
        }
      }
    } catch {}
  });

  wsDiscord.on('close', () => {
    gatewayReady = false;
    broadcastState();
    clearInterval(heartbeatTimer);
    setTimeout(initGateway, 1500);
  });

  wsDiscord.on('error', () => {
    try { wsDiscord.close(); } catch {}
  });
}

// ---------------------- HTTP & FRONTEND SUNUCUSU ----------------------
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Arayüz dosyası bulunamadı.');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      }
    });
  } else if (req.url === '/avatar.jpg') {
    const imgPath = path.join(__dirname, 'avatar.jpg');
    fs.readFile(imgPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(data);
      }
    });
  } else if (req.url === '/operasyon.mp3') {
    const audioPath = path.join(__dirname, 'operasyon.mp3');
    fs.readFile(audioPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(data);
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ---------------------- DASHBOARD WEBSOCKET SUNUCUSU ----------------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  clients.add(ws);
  broadcastState();

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.action === 'setMode') {
        selectedMode = Number(data.mode);
        broadcastLog('MOD', 'system', `Çalışma modu değiştirildi: Mod ${selectedMode}`);
        broadcastState();
      } else if (data.action === 'setTargetVanity') {
        targetVanityCode = data.code;
        broadcastLog('HEDEF', 'system', `Hedef vanity güncellendi: "${targetVanityCode}"`);
        broadcastState();
      } else if (data.action === 'toggleLock') {
        isLocked = false;
        broadcastLog('KİLİT', 'system', 'Sistem kilidi açıldı. Sniper tekrar aktif!');
        broadcastState();
      } else if (data.action === 'saveConfig') {
        if (data.serverId) CONFIG.serverId = data.serverId;
        if (data.webhook) CONFIG.webhookUrl = data.webhook;
        rebuildAllBuffers();
        broadcastLog('CONFIG', 'system', 'Sunucu ID ve Webhook ayarları güncellendi.');
      }
    } catch {}
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

// ---------------------- BAŞLAT ----------------------
server.listen(CONFIG.port, () => {
  console.clear();
  console.log(`
\x1b[35m======================================================
         KAYZER AIRLINES — WEB CONTROL CENTER
              Developed by DB & Kayzer
======================================================\x1b[0m

\x1b[32m[✓]\x1b[0m Web Arayüzü Hazır!
\x1b[36m👉 Tarayıcında Aç:\x1b[0m \x1b[1mhttp://localhost:${CONFIG.port}\x1b[0m

Radar arka planda başlatılıyor...
`);

  initGateway();
  setInterval(refreshMfaToken, 2 * 60 * 1000);
});
