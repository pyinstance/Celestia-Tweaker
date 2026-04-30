const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const index = trimmed.indexOf('=');
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim().replace(/^\uFEFF/, '');
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && !process.env[key]) process.env[key] = value;
  }
}

loadEnvFile();

let mainWindow = null;
let authServer = null;
let latestDiscordUser = null;

function sessionPath() {
  return path.join(app.getPath('userData'), 'celestia-session.json');
}

function saveDiscordSession(user) {
  try {
    fs.mkdirSync(path.dirname(sessionPath()), { recursive: true });
    fs.writeFileSync(sessionPath(), JSON.stringify({ user, savedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error('[Discord session] Failed to save:', err.message);
  }
}

function loadDiscordSession() {
  try {
    const file = sessionPath();
    if (!fs.existsSync(file)) return null;
    const session = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!session || !session.user || !session.user.id) return null;
    latestDiscordUser = session.user;
    return latestDiscordUser;
  } catch (err) {
    console.error('[Discord session] Failed to load:', err.message);
    return null;
  }
}

function clearDiscordSession() {
  try {
    const file = sessionPath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err) {
    console.error('[Discord session] Failed to clear:', err.message);
  }
  latestDiscordUser = null;
}


function dataPath(name) {
  return path.join(app.getPath('userData'), name);
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonSafe(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

function startupStorePath() {
  return dataPath('celestia-startup.json');
}

function activityLogPath() {
  return dataPath('celestia-activity-log.json');
}
function undoPath() {
  return dataPath('celestia-undo.json');
}

function readUndoStack() {
  const rows = readJsonSafe(undoPath(), []);
  return Array.isArray(rows) ? rows : [];
}

function writeUndoStack(rows) {
  return writeJsonSafe(undoPath(), Array.isArray(rows) ? rows.slice(0, 25) : []);
}

function pushUndoGroup(label, actions) {
  const clean = (actions || []).filter(x => x && x.kind && x.id);
  if (!clean.length) return null;
  const group = {
    id: crypto.randomBytes(8).toString('hex'),
    label: label || 'Last change',
    time: new Date().toISOString(),
    actions: clean
  };
  const stack = readUndoStack();
  stack.unshift(group);
  writeUndoStack(stack);
  return group;
}


function readActivityLog() {
  const rows = readJsonSafe(activityLogPath(), []);
  return Array.isArray(rows) ? rows.slice(0, 150) : [];
}

function addActivityLog(type, title, detail, meta) {
  const row = {
    id: crypto.randomBytes(8).toString('hex'),
    time: new Date().toISOString(),
    type: type || 'info',
    title: title || 'Activity',
    detail: detail || '',
    meta: meta || {}
  };
  const rows = readActivityLog();
  rows.unshift(row);
  writeJsonSafe(activityLogPath(), rows.slice(0, 150));
  return row;
}

function clearActivityLog() {
  writeJsonSafe(activityLogPath(), []);
  return { ok: true, rows: [] };
}

function disabledStartupDir() {
  return dataPath('disabled-startup-items');
}

function startupFolderPaths() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
  return [
    { source: 'Current user', dir: path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') },
    { source: 'All users', dir: path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') }
  ];
}

function listFolderStartupItems() {
  if (process.platform !== 'win32') return [];
  const disabled = readJsonSafe(startupStorePath(), {});
  const rows = [];
  for (const folder of startupFolderPaths()) {
    try {
      if (!fs.existsSync(folder.dir)) continue;
      const files = fs.readdirSync(folder.dir, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile()) continue;
        const full = path.join(folder.dir, file.name);
        const id = Buffer.from('file|' + full).toString('base64');
        rows.push({
          id,
          kind: 'file',
          source: folder.source,
          name: file.name.replace(/\.(lnk|url|bat|cmd|exe)$/i, ''),
          type: 'FILE',
          data: full,
          path: full,
          enabled: true
        });
      }
    } catch (_) {}
  }
  for (const id of Object.keys(disabled)) {
    const item = disabled[id];
    if (item && item.kind === 'file' && !rows.some(x => x.id === id)) rows.push({ ...item, enabled: false });
  }
  return rows;
}

function startupImpact(item) {
  const text = String((item && (item.name + ' ' + item.data)) || '').toLowerCase();
  let score = 18;
  const high = ['steam', 'epic', 'ea ', 'battle.net', 'battlenet', 'adobe', 'creative cloud', 'teams', 'spotify', 'discord', 'onedrive', 'dropbox', 'google drive', 'chrome', 'edge', 'launcher', 'update', 'helper'];
  const medium = ['tray', 'agent', 'monitor', 'service', 'sync', 'driver', 'control panel', 'updater'];
  for (const word of high) if (text.includes(word)) score += 26;
  for (const word of medium) if (text.includes(word)) score += 12;
  if (text.includes('security') || text.includes('defender') || text.includes('antivirus') || text.includes('realtek') || text.includes('nvidia') || text.includes('amd')) score -= 12;
  if (!item || item.enabled === false) score = Math.max(0, score - 16);
  score = Math.max(0, Math.min(100, score));
  if (score >= 55) return { level: 'high', label: 'High', score };
  if (score >= 28) return { level: 'medium', label: 'Medium', score };
  return { level: 'low', label: 'Low', score };
}

function parseRegRows(text, source, keyPath) {
  return String(text || '').split(/\r?\n/).map(line => {
    const m = line.match(/^\s{4}(.+?)\s{2,}(REG_\w+)\s{2,}(.+)$/);
    if (!m) return null;
    const name = m[1].trim();
    const type = m[2].trim();
    const data = m[3].trim();
    return {
      id: Buffer.from(source + '|' + name).toString('base64'),
      source,
      name,
      type,
      data,
      enabled: true,
      path: keyPath
    };
  }).filter(Boolean);
}

async function listStartupItems() {
  if (process.platform !== 'win32') return { ok: true, items: [] };
  const keys = [
    { source: 'Current user', path: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' },
    { source: 'All users', path: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' }
  ];
  const disabled = readJsonSafe(startupStorePath(), {});
  const items = [];
  for (const key of keys) {
    const res = await run(`reg query "${key.path}"`, 12000);
    if (res.ok) {
      const rows = parseRegRows(res.stdout, key.source, key.path).map(item => ({ ...item, kind: 'registry' }));
      items.push(...rows);
    }
  }
  items.push(...listFolderStartupItems());
  for (const id of Object.keys(disabled)) {
    const item = disabled[id];
    if (item && item.kind !== 'file' && !items.some(x => x.id === id)) items.push({ ...item, enabled: false });
  }
  const enriched = items.map(item => ({ ...item, impact: startupImpact(item) }));
  return { ok: true, items: enriched.sort((a, b) => b.impact.score - a.impact.score || a.name.localeCompare(b.name)) };
}

async function setStartupItem(id, enabled) {
  if (process.platform !== 'win32') return { ok: false, error: 'Startup control is Windows only.' };
  const decoded = Buffer.from(String(id || ''), 'base64').toString('utf8');
  const split = decoded.split('|');
  const kind = split[0];
  const all = await listStartupItems();
  const item = (all.items || []).find(x => x.id === id);
  const store = readJsonSafe(startupStorePath(), {});
  if (!item && !store[id]) return { ok: false, error: 'Startup item not found.' };

  if (kind === 'file') {
    const target = item || store[id];
    fs.mkdirSync(disabledStartupDir(), { recursive: true });
    if (!enabled) {
      const safeName = Buffer.from(id).toString('base64url') + '.disabled';
      const disabledPath = path.join(disabledStartupDir(), safeName);
      try {
        fs.renameSync(target.path, disabledPath);
      } catch (err) {
        return { ok: false, error: err.message || 'Could not disable startup item.' };
      }
      store[id] = { ...target, enabled: false, disabledPath };
      writeJsonSafe(startupStorePath(), store);
      addActivityLog('startup', 'Startup item disabled', target.name, { item: target.name, source: target.source });
      pushUndoGroup('Startup item disabled', [{ kind: 'startup', id, enabled: true }]);
      return { ok: true, message: `${target.name} disabled`, item: { ...target, enabled: false } };
    }
    const saved = store[id] || target;
    try {
      fs.mkdirSync(path.dirname(saved.path), { recursive: true });
      fs.renameSync(saved.disabledPath, saved.path);
    } catch (err) {
      return { ok: false, error: err.message || 'Could not enable startup item.' };
    }
    delete store[id];
    writeJsonSafe(startupStorePath(), store);
    addActivityLog('startup', 'Startup item enabled', saved.name, { item: saved.name, source: saved.source });
    pushUndoGroup('Startup item enabled', [{ kind: 'startup', id, enabled: false }]);
    return { ok: true, message: `${saved.name} enabled`, item: { ...saved, enabled: true } };
  }

  const decodedParts = decoded.split('|');
  const source = decodedParts[0];
  const name = decodedParts.slice(1).join('|');
  if (!source || !name) return { ok: false, error: 'Invalid startup item.' };
  const target = item || store[id];
  if (!enabled) {
    store[id] = target;
    const res = await run(`reg delete "${target.path}" /v "${target.name}" /f`, 12000);
    if (!res.ok) return { ok: false, error: res.stderr || res.error || 'Could not disable startup item.' };
    writeJsonSafe(startupStorePath(), store);
    addActivityLog('startup', 'Startup item disabled', target.name, { item: target.name, source: target.source });
    pushUndoGroup('Startup item disabled', [{ kind: 'startup', id, enabled: true }]);
    return { ok: true, message: `${target.name} disabled`, item: { ...target, enabled: false } };
  }
  const saved = store[id] || target;
  if (!saved.path || !saved.name || !saved.type || saved.data == null) return { ok: false, error: 'No saved command available for this item.' };
  const value = String(saved.data).replace(/"/g, '\\\"');
  const res = await run(`reg add "${saved.path}" /v "${saved.name}" /t ${saved.type} /d "${value}" /f`, 12000);
  if (!res.ok) return { ok: false, error: res.stderr || res.error || 'Could not enable startup item.' };
  delete store[id];
  writeJsonSafe(startupStorePath(), store);
  addActivityLog('startup', 'Startup item enabled', saved.name, { item: saved.name, source: saved.source });
  pushUndoGroup('Startup item enabled', [{ kind: 'startup', id, enabled: false }]);
  return { ok: true, message: `${saved.name} enabled`, item: { ...saved, enabled: true } };
}

const CONFIG_PATH = path.join(__dirname, 'discord.config.json');
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://127.0.0.1:37271/callback';
const REDIRECT_URL = new URL(REDIRECT_URI);
const AUTH_PORT = Number(REDIRECT_URL.port || (REDIRECT_URL.protocol === 'https:' ? 443 : 80));

function readDiscordConfig() {
  const envCfg = {
    clientId: String(process.env.DISCORD_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.DISCORD_CLIENT_SECRET || '').trim(),
    redirectUri: String(REDIRECT_URI || '').trim()
  };

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return {
        clientId: String(envCfg.clientId || fileCfg.clientId || '').trim(),
        clientSecret: String(envCfg.clientSecret || fileCfg.clientSecret || '').trim(),
        redirectUri: String(REDIRECT_URI || '').trim()
      };
    }
  } catch (err) {
    console.error('[Discord config] Failed to read config:', err.message);
  }

  return envCfg;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    frame: process.platform === 'darwin' ? true : false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    transparent: false,
    backgroundColor: '#0b0b0d',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    const sessionUser = loadDiscordSession();
    if (sessionUser) mainWindow.webContents.send('discord-auth-success', sessionUser);
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.env.NODE_ENV === 'development') mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopAuthServer();
  if (process.platform !== 'darwin') app.quit();
});

function requestJson(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else {
            const detail = json.error_description || json.error || json.message || data || `HTTP ${res.statusCode}`;
            const e = new Error(`HTTP ${res.statusCode}: ${detail}`);
            e.statusCode = res.statusCode;
            e.responseBody = json;
            reject(e);
          }
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

function avatarUrl(user, size = 256) {
  if (!user || !user.avatar) return null;
  const ext = String(user.avatar).startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=${size}`;
}

function normaliseDiscordUser(raw) {
  return {
    id: raw.id,
    username: raw.username,
    discriminator: raw.discriminator || '0',
    global_name: raw.global_name || null,
    display_name: raw.global_name || raw.username,
    avatar: avatarUrl(raw),
    avatar_hash: raw.avatar || null,
    accent_color: raw.accent_color || null,
    banner_color: raw.banner_color || null,
    public_flags: raw.public_flags || 0,
    locale: raw.locale || null,
    verified: typeof raw.verified === 'boolean' ? raw.verified : null,
    fetchedAt: new Date().toISOString(),
  };
}

function stopAuthServer() {
  if (authServer) {
    try { authServer.close(); } catch (_) {}
    authServer = null;
  }
}

async function exchangeDiscordCode(code, cfg) {
  const form = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  }).toString();

  const token = await requestJson('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(form),
    }
  }, form);

  const me = await requestJson('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });

  return normaliseDiscordUser(me);
}

function renderCallbackPage(success, safeMessage) {
  const title = success ? 'Discord connected' : 'Discord login failed';
  const message = success ? 'Your profile has been linked successfully. You can close this tab and return to Celestia.' : (safeMessage || 'Authentication could not be completed. Return to Celestia and try again.');
  const badge = success ? 'Authentication complete' : 'Authentication failed';
  const accent = success ? '#ff4fa3' : '#ef4444';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Celestia - ${title}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 30%,rgba(255,79,163,.16),transparent 30%),linear-gradient(180deg,#08080f,#030307);color:#f8fafc;font-family:Inter,Segoe UI,Arial,sans-serif;overflow:hidden}.stars{position:fixed;inset:0;background-image:radial-gradient(circle at 12% 22%,rgba(255,255,255,.55) 0 1px,transparent 1px),radial-gradient(circle at 82% 18%,rgba(255,79,163,.65) 0 1px,transparent 1px),radial-gradient(circle at 72% 70%,rgba(255,255,255,.38) 0 1px,transparent 1px),radial-gradient(circle at 22% 75%,rgba(251,134,189,.52) 0 1px,transparent 1px);animation:drift 10s linear infinite}.card{position:relative;width:min(520px,calc(100vw - 36px));padding:42px 36px;border-radius:28px;background:rgba(15,15,25,.82);border:1px solid rgba(255,79,163,.28);box-shadow:0 38px 100px rgba(0,0,0,.65),0 0 120px rgba(255,79,163,.14);text-align:center;backdrop-filter:blur(22px);animation:pop .5s cubic-bezier(.2,.8,.2,1) both}.mark{width:86px;height:86px;margin:0 auto 20px;filter:drop-shadow(0 0 28px rgba(255,79,163,.55));animation:pulse 3s ease-in-out infinite}.brand{font-size:12px;letter-spacing:.28em;text-indent:.28em;text-transform:uppercase;color:#ff8fc4;margin-bottom:12px;font-weight:800}h1{margin:0;font-size:30px;letter-spacing:-.05em}p{margin:14px auto 0;max-width:370px;color:rgba(235,235,242,.65);font-size:15px;line-height:1.6}.status{margin-top:26px;display:inline-flex;align-items:center;gap:9px;padding:11px 16px;border-radius:999px;background:rgba(255,79,163,.10);border:1px solid rgba(255,79,163,.26);color:#ffd1e8;font-size:13px;font-weight:800}.dot{width:8px;height:8px;border-radius:999px;background:${accent};box-shadow:0 0 18px ${accent}}@keyframes pop{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}@keyframes drift{from{transform:translateY(0)}to{transform:translateY(22px)}}</style></head><body><div class="stars"></div><main class="card"><svg class="mark" viewBox="0 0 80 80" fill="none"><defs><linearGradient id="g" x1="9" y1="7" x2="70" y2="72"><stop stop-color="#fff"/><stop offset=".36" stop-color="#ffd1e8"/><stop offset="1" stop-color="#ff4fa3"/></linearGradient></defs><circle cx="40" cy="40" r="29" stroke="rgba(255,79,163,.38)" stroke-width="2" stroke-dasharray="48 22"/><path d="M40 4l9.4 26.6L76 40l-26.6 9.4L40 76l-9.4-26.6L4 40l26.6-9.4L40 4z" fill="url(#g)"/></svg><div class="brand">Celestia</div><h1>${title}</h1><p>${message}</p><div class="status"><span class="dot"></span>${badge}</div></main></body></html>`;
}

function startDiscordAuth() {
  const cfg = readDiscordConfig();
  if (!cfg.clientId || !cfg.clientSecret || cfg.clientId.includes('PASTE_') || cfg.clientSecret.includes('PASTE_')) {
    return { ok: false, error: 'Discord OAuth is not configured. Check your .env file has DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI.' };
  }

  stopAuthServer();
  const state = crypto.randomBytes(24).toString('hex');

  authServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, REDIRECT_URI);
    if (reqUrl.pathname !== '/callback') {
      res.writeHead(404); res.end('Not found'); return;
    }

    const code = reqUrl.searchParams.get('code');
    const gotState = reqUrl.searchParams.get('state');
    if (!code || gotState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(renderCallbackPage(false, 'Invalid Discord callback. Please restart login from Celestia.'));
      return;
    }

    try {
      latestDiscordUser = await exchangeDiscordCode(code, cfg);
      saveDiscordSession(latestDiscordUser);
      if (mainWindow) mainWindow.webContents.send('discord-auth-success', latestDiscordUser);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderCallbackPage(true));
    } catch (err) {
      let msg = String(err.message || err).replace(/[<>]/g, '');
      if (err.statusCode === 401 || msg.includes('HTTP 401') || msg.includes('invalid_client')) {
        msg = 'Discord rejected the OAuth credentials. Regenerate/copy the OAuth2 Client Secret in the Discord Developer Portal, paste it into .env, and make sure the Redirect URL is exactly http://localhost:3000/callback.';
      }
      if (mainWindow) mainWindow.webContents.send('discord-auth-error', msg);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h2>Celestia Discord login failed</h2><p>${msg}</p>`);
    } finally {
      setTimeout(stopAuthServer, 1000);
    }
  });

  authServer.listen(AUTH_PORT, () => {
    const authUrl = new URL('https://discord.com/api/oauth2/authorize');
    authUrl.searchParams.set('client_id', cfg.clientId);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'identify');
    authUrl.searchParams.set('state', state);
    shell.openExternal(authUrl.toString());
  });

  return { ok: true, redirectUri: REDIRECT_URI };
}

{
function parsePingMs(text) {
  const s = String(text || '');
  let m = s.match(/Average\s*=\s*(\d+)ms/i) || s.match(/time[=<](\d+)ms/i) || s.match(/Minimum\s*=\s*\d+ms,\s*Maximum\s*=\s*\d+ms,\s*Average\s*=\s*(\d+)ms/i);
  return m ? Number(m[1]) : null;
}

function activeNetworkAdapters() {
  const nets = os.networkInterfaces();
  const rows = [];
  Object.keys(nets).forEach(name => {
    const usable = (nets[name] || []).filter(x => !x.internal && (x.family === 'IPv4' || x.family === 4));
    usable.forEach(x => rows.push({ name, address: x.address, mac: x.mac || '—' }));
  });
  return rows;
}

async function getNetworkStatus() {
  const adapters = activeNetworkAdapters();
  const target = '1.1.1.1';
  const cmd = process.platform === 'win32' ? `ping -n 2 ${target}` : `ping -c 2 ${target}`;
  const ping = await run(cmd, 9000);
  let dns = [];
  if (process.platform === 'win32') {
    const dnsRes = await run(`powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Select-Object -Unique -First 8 } catch { '' }"`, 9000);
    dns = String(dnsRes.stdout || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 8);
    if (!dns.length) {
      const ipconfig = await run('ipconfig /all', 9000);
      dns = String(ipconfig.stdout || '').split(/\r?\n/).map(x => x.trim()).map(x => x.replace(/^DNS Servers[^:]*:\s*/i, '').trim()).filter(x => /^\d{1,3}(\.\d{1,3}){3}$/.test(x)).slice(0, 8);
    }
  }
  const latency = parsePingMs(ping.stdout || ping.stderr);
  const online = (ping.ok && latency !== null) || adapters.length > 0;
  const quality = latency === null ? (adapters.length ? 'Connected' : 'Offline') : latency <= 35 ? 'Excellent' : latency <= 75 ? 'Good' : latency <= 130 ? 'Fair' : 'Poor';
  return {
    ok: true,
    online,
    latency,
    quality,
    target,
    adapters,
    adapterCount: adapters.length,
    primaryIp: adapters[0] ? adapters[0].address : '—',
    dns,
    checkedAt: new Date().toISOString()
  };
}

async function undoLastChange() {
  const stack = readUndoStack();
  const group = stack.shift();
  if (!group) return { ok: false, error: 'Nothing to undo.' };
  const results = [];
  for (const action of group.actions || []) {
    if (action.kind === 'tweak') results.push(await verifiedRun(action.id, !!action.enabled));
    if (action.kind === 'service') results.push(await setServiceMode(action.id, action.mode, true));
    if (action.kind === 'startup') results.push(await setStartupItem(action.id, !!action.enabled));
  }
  writeUndoStack(stack);
  addActivityLog('undo', 'Undo completed', group.label, { results: results.length });
  return { ok: results.every(x => x && x.ok), label: group.label, results, remaining: stack.length };
}
}
ipcMain.handle('discord-start-auth', async () => startDiscordAuth());
ipcMain.handle('discord-get-latest-user', async () => latestDiscordUser || loadDiscordSession());
ipcMain.handle('discord-logout', async () => { clearDiscordSession(); return { ok: true }; });
ipcMain.handle('discord-config-status', async () => {
  const cfg = readDiscordConfig();
  return { configured: !!(cfg.clientId && cfg.clientSecret && !cfg.clientId.includes('PASTE_') && !cfg.clientSecret.includes('PASTE_')), redirectUri: REDIRECT_URI };
});

ipcMain.handle('get-network-status', async () => {
  try {
    return await getNetworkStatus();
  } catch (err) {
    return { ok: false, online: false, latency: null, quality: 'Unavailable', target: '1.1.1.1', adapters: [], adapterCount: 0, primaryIp: '—', dns: [], error: err && err.message ? err.message : String(err) };
  }
});
ipcMain.handle('undo-last-change', async () => undoLastChange());

ipcMain.handle('get-system-info', async () => {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const nets = os.networkInterfaces();
  const ipv4 = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ipv4.push(`${name}: ${net.address}`);
    }
  }
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpuModel: cpus[0]?.model || 'Unknown CPU',
    cpuCores: cpus.length,
    totalMemGb: Math.round(totalMem / 1024 / 1024 / 1024 * 10) / 10,
    usedMemMb: Math.round(usedMem / 1024 / 1024),
    memPct: Math.round(usedMem / totalMem * 100),
    uptime: Math.floor(os.uptime() / 3600) + 'h ' + Math.floor((os.uptime() % 3600) / 60) + 'm',
    ipv4,
  };
});

function run(command, timeout = 15000) {
  return new Promise((resolve) => {
    exec(command, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '', error: error ? error.message : null });
    });
  });
}

const PS = 'powershell -NoProfile -ExecutionPolicy Bypass -Command ';
const tweakCommands = {
  'high-perf': {
    on: 'powercfg -setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',
    off: 'powercfg -setactive 381b4222-f694-41f0-9685-ff5bb260df2e'
  },
  'timer-res': {
    on: 'bcdedit /set useplatformtick yes && bcdedit /deletevalue useplatformclock',
    off: 'bcdedit /deletevalue useplatformtick'
  },
  'core-park': {
    on: 'powercfg -setacvalueindex SCHEME_CURRENT SUB_PROCESSOR CPMINCORES 100 && powercfg -setactive SCHEME_CURRENT',
    off: 'powercfg -setacvalueindex SCHEME_CURRENT SUB_PROCESSOR CPMINCORES 0 && powercfg -setactive SCHEME_CURRENT'
  },
  'sysmain': {
    on: 'sc stop SysMain & sc config SysMain start=disabled',
    off: 'sc config SysMain start=auto & sc start SysMain'
  },
  'mem-compress': {
    on: PS + '"Disable-MMAgent -MemoryCompression"',
    off: PS + '"Enable-MMAgent -MemoryCompression"'
  },
  'page-exec': {
    on: 'bcdedit /set nx AlwaysOn',
    off: 'bcdedit /set nx OptIn'
  },
  'tcp-auto': {
    on: 'netsh int tcp set global autotuninglevel=normal',
    off: 'netsh int tcp set global autotuninglevel=disabled'
  },
  'nagle': {
    on: 'reg add "HKLM\\SOFTWARE\\Microsoft\\MSMQ\\Parameters" /v TCPNoDelay /t REG_DWORD /d 1 /f',
    off: 'reg delete "HKLM\\SOFTWARE\\Microsoft\\MSMQ\\Parameters" /v TCPNoDelay /f'
  },
  'qos': {
    on: 'reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Psched" /v NonBestEffortLimit /t REG_DWORD /d 0 /f',
    off: 'reg delete "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Psched" /v NonBestEffortLimit /f'
  },
  'dns-cache': {
    on: 'sc config Dnscache start=auto & sc start Dnscache',
    off: 'sc stop Dnscache & sc config Dnscache start=disabled'
  },
  'ipv6': {
    on: 'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters" /v DisabledComponents /t REG_DWORD /d 255 /f',
    off: 'reg delete "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters" /v DisabledComponents /f'
  },
  'arp-cache': {
    on: 'netsh interface ipv4 set global neighborcachelimit=4096',
    off: 'netsh interface ipv4 set global neighborcachelimit=256'
  },
  'telemetry': {
    on: 'reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection" /v AllowTelemetry /t REG_DWORD /d 0 /f',
    off: 'reg delete "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection" /v AllowTelemetry /f'
  },
  'cortana': {
    on: 'reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search" /v AllowCortana /t REG_DWORD /d 0 /f',
    off: 'reg delete "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search" /v AllowCortana /f'
  },
  'ad-id': {
    on: 'reg add "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo" /v Enabled /t REG_DWORD /d 0 /f',
    off: 'reg add "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo" /v Enabled /t REG_DWORD /d 1 /f'
  },
  'feedback': {
    on: 'reg add "HKCU\\Software\\Microsoft\\Siuf\\Rules" /v NumberOfSIUFInPeriod /t REG_DWORD /d 0 /f',
    off: 'reg delete "HKCU\\Software\\Microsoft\\Siuf\\Rules" /v NumberOfSIUFInPeriod /f'
  },
  'timeline': {
    on: 'reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System" /v EnableActivityFeed /t REG_DWORD /d 0 /f',
    off: 'reg delete "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System" /v EnableActivityFeed /f'
  },
  'onedrive': {
    on: 'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v OneDrive /f',
    off: 'cmd /c echo Launch OneDrive manually from Start Menu to re-enable startup'
  },
  'anim-off': {
    on: 'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects" /v VisualFXSetting /t REG_DWORD /d 2 /f',
    off: 'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects" /v VisualFXSetting /t REG_DWORD /d 0 /f'
  },
  'trans-off': {
    on: 'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v EnableTransparency /t REG_DWORD /d 0 /f',
    off: 'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v EnableTransparency /t REG_DWORD /d 1 /f'
  },
  'cleartype': {
    on: 'reg add "HKCU\\Control Panel\\Desktop" /v FontSmoothing /t REG_SZ /d 2 /f',
    off: 'reg add "HKCU\\Control Panel\\Desktop" /v FontSmoothing /t REG_SZ /d 0 /f'
  },
  'dpi-aware': {
    on: 'reg add "HKCU\\Control Panel\\Desktop" /v LogPixels /t REG_DWORD /d 96 /f',
    off: 'reg delete "HKCU\\Control Panel\\Desktop" /v LogPixels /f'
  },
  'dark-mode': {
    on: 'reg add "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v AppsUseLightTheme /t REG_DWORD /d 0 /f & reg add "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v SystemUsesLightTheme /t REG_DWORD /d 0 /f',
    off: 'reg add "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v AppsUseLightTheme /t REG_DWORD /d 1 /f & reg add "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v SystemUsesLightTheme /t REG_DWORD /d 1 /f'
  },
  'wallpaper-q': {
    on: 'reg add "HKCU\\Control Panel\\Desktop" /v JPEGImportQuality /t REG_DWORD /d 100 /f',
    off: 'reg delete "HKCU\\Control Panel\\Desktop" /v JPEGImportQuality /f'
  },
  'game-mode': {
    on: 'reg add "HKCU\\SOFTWARE\\Microsoft\\GameBar" /v AutoGameModeEnabled /t REG_DWORD /d 1 /f',
    off: 'reg add "HKCU\\SOFTWARE\\Microsoft\\GameBar" /v AutoGameModeEnabled /t REG_DWORD /d 0 /f'
  },
  'gpu-hags': {
    on: 'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers" /v HwSchMode /t REG_DWORD /d 2 /f',
    off: 'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers" /v HwSchMode /t REG_DWORD /d 1 /f'
  },
  'mouse-accel': {
    on: 'reg add "HKCU\\Control Panel\\Mouse" /v MouseSpeed /t REG_SZ /d 0 /f & reg add "HKCU\\Control Panel\\Mouse" /v MouseThreshold1 /t REG_SZ /d 0 /f & reg add "HKCU\\Control Panel\\Mouse" /v MouseThreshold2 /t REG_SZ /d 0 /f',
    off: 'reg add "HKCU\\Control Panel\\Mouse" /v MouseSpeed /t REG_SZ /d 1 /f'
  },
  'xinput': {
    on: 'cmd /c echo XInput polling tweak requires a driver-specific tool; marked active only.',
    off: 'cmd /c echo XInput polling restored in app state only.'
  },
  'priority': {
    on: 'reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\Game.exe\\PerfOptions" /v CpuPriorityClass /t REG_DWORD /d 3 /f',
    off: 'reg delete "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\Game.exe\\PerfOptions" /v CpuPriorityClass /f'
  },
  'excl-fs': {
    on: 'reg add "HKCU\\System\\GameConfigStore" /v GameDVR_FSEBehaviorMode /t REG_DWORD /d 2 /f',
    off: 'reg add "HKCU\\System\\GameConfigStore" /v GameDVR_FSEBehaviorMode /t REG_DWORD /d 0 /f'
  },
  'shader-pre': {
    on: 'cmd /c echo Shader pre-compilation is game-specific; marked active only.',
    off: 'cmd /c echo Shader pre-compilation restored in app state only.'
  },
  'cpu-affin': {
    on: 'cmd /c echo CPU affinity must be applied per game process; marked active only.',
    off: 'cmd /c echo CPU affinity restored in app state only.'
  },
};


Object.assign(tweakCommands, {
  'hw-sched': {
    on: 'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers" /v HwSchMode /t REG_DWORD /d 2 /f',
    off: 'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers" /v HwSchMode /t REG_DWORD /d 1 /f'
  },
  'ssd-trim': {
    on: 'schtasks /Change /TN "\\Microsoft\\Windows\\Defrag\\ScheduledDefrag" /ENABLE',
    off: 'schtasks /Change /TN "\\Microsoft\\Windows\\Defrag\\ScheduledDefrag" /DISABLE'
  },
  'prefetch': {
    on: 'sc stop SysMain & sc config SysMain start=disabled',
    off: 'sc config SysMain start=auto & sc start SysMain'
  },
  'bcdedit': {
    on: 'bcdedit /timeout 0',
    off: 'bcdedit /timeout 30'
  },
  'dns-doh': {
    on: PS + "\"Set-DnsClientServerAddress -InterfaceAlias * -ServerAddresses ('1.1.1.1','1.0.0.1') -ErrorAction SilentlyContinue\"",
    off: PS + '"Set-DnsClientServerAddress -InterfaceAlias * -ResetServerAddresses -ErrorAction SilentlyContinue"'
  },
  'nagle-off': {
    on: 'reg add "HKLM\\SOFTWARE\\Microsoft\\MSMQ\\Parameters" /v TCPNoDelay /t REG_DWORD /d 1 /f',
    off: 'reg delete "HKLM\\SOFTWARE\\Microsoft\\MSMQ\\Parameters" /v TCPNoDelay /f'
  },
  'qos-bw': {
    on: 'reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Psched" /v NonBestEffortLimit /t REG_DWORD /d 0 /f',
    off: 'reg delete "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Psched" /v NonBestEffortLimit /f'
  },
  'tcp-buf': {
    on: 'netsh int tcp set global autotuninglevel=normal',
    off: 'netsh int tcp set global autotuninglevel=disabled'
  },
  'net-throttle': {
    on: 'reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v NetworkThrottlingIndex /t REG_DWORD /d 4294967295 /f',
    off: 'reg delete "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v NetworkThrottlingIndex /f'
  }
});


function normCheckValue(v) {
  if (v === null || v === undefined || v === '') return 'missing';
  return String(v).trim().toLowerCase();
}

async function readReg(pathName, valueName) {
  const res = await run(`reg query "${pathName}" /v ${valueName}`, 7000);
  if (!res.ok) return { ok: false, value: 'missing', raw: res.stderr || res.stdout || res.error || '' };
  const lines = String(res.stdout || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const row = lines.find(x => x.toLowerCase().startsWith(valueName.toLowerCase() + ' '));
  if (!row) return { ok: false, value: 'missing', raw: res.stdout || '' };
  const parts = row.split(/\s+/);
  return { ok: true, value: parts.slice(2).join(' ') || 'present', raw: row };
}

async function readPowerPlan() {
  const res = await run('powercfg /getactivescheme', 7000);
  const text = res.stdout || res.stderr || '';
  const m = text.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  return { ok: !!m, value: m ? m[1].toLowerCase() : 'unknown', raw: text.trim() };
}

const verificationRules = {
  'high-perf': { type: 'power', target: 'Active power scheme', on: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c', off: '381b4222-f694-41f0-9685-ff5bb260df2e' },
  'telemetry': { type: 'reg', target: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection\\AllowTelemetry', path: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection', value: 'AllowTelemetry', on: '0x0', off: 'missing' },
  'cortana': { type: 'reg', target: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search\\AllowCortana', path: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search', value: 'AllowCortana', on: '0x0', off: 'missing' },
  'ad-id': { type: 'reg', target: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo\\Enabled', path: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo', value: 'Enabled', on: '0x0', off: '0x1' },
  'feedback': { type: 'reg', target: 'HKCU\\Software\\Microsoft\\Siuf\\Rules\\NumberOfSIUFInPeriod', path: 'HKCU\\Software\\Microsoft\\Siuf\\Rules', value: 'NumberOfSIUFInPeriod', on: '0x0', off: 'missing' },
  'timeline': { type: 'reg', target: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System\\EnableActivityFeed', path: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System', value: 'EnableActivityFeed', on: '0x0', off: 'missing' },
  'ipv6': { type: 'reg', target: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters\\DisabledComponents', path: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters', value: 'DisabledComponents', on: '0xff', off: 'missing' },
  'qos': { type: 'reg', target: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Psched\\NonBestEffortLimit', path: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Psched', value: 'NonBestEffortLimit', on: '0x0', off: 'missing' },
  'qos-bw': { type: 'reg', target: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Psched\\NonBestEffortLimit', path: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Psched', value: 'NonBestEffortLimit', on: '0x0', off: 'missing' },
  'nagle': { type: 'reg', target: 'HKLM\\SOFTWARE\\Microsoft\\MSMQ\\Parameters\\TCPNoDelay', path: 'HKLM\\SOFTWARE\\Microsoft\\MSMQ\\Parameters', value: 'TCPNoDelay', on: '0x1', off: 'missing' },
  'nagle-off': { type: 'reg', target: 'HKLM\\SOFTWARE\\Microsoft\\MSMQ\\Parameters\\TCPNoDelay', path: 'HKLM\\SOFTWARE\\Microsoft\\MSMQ\\Parameters', value: 'TCPNoDelay', on: '0x1', off: 'missing' },
  'net-throttle': { type: 'reg', target: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\NetworkThrottlingIndex', path: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile', value: 'NetworkThrottlingIndex', on: '0xffffffff', off: 'missing' },
  'anim-off': { type: 'reg', target: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects\\VisualFXSetting', path: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects', value: 'VisualFXSetting', on: '0x2', off: '0x0' },
  'trans-off': { type: 'reg', target: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\\EnableTransparency', path: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', value: 'EnableTransparency', on: '0x0', off: '0x1' },
  'dark-mode': { type: 'reg', target: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\\AppsUseLightTheme', path: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', value: 'AppsUseLightTheme', on: '0x0', off: '0x1' },
  'wallpaper-q': { type: 'reg', target: 'HKCU\\Control Panel\\Desktop\\JPEGImportQuality', path: 'HKCU\\Control Panel\\Desktop', value: 'JPEGImportQuality', on: '0x64', off: 'missing' },
  'game-mode': { type: 'reg', target: 'HKCU\\SOFTWARE\\Microsoft\\GameBar\\AutoGameModeEnabled', path: 'HKCU\\SOFTWARE\\Microsoft\\GameBar', value: 'AutoGameModeEnabled', on: '0x1', off: '0x0' },
  'gpu-hags': { type: 'reg', target: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers\\HwSchMode', path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', value: 'HwSchMode', on: '0x2', off: '0x1' },
  'hw-sched': { type: 'reg', target: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers\\HwSchMode', path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', value: 'HwSchMode', on: '0x2', off: '0x1' },
  'mouse-accel': { type: 'reg', target: 'HKCU\\Control Panel\\Mouse\\MouseSpeed', path: 'HKCU\\Control Panel\\Mouse', value: 'MouseSpeed', on: '0', off: '1' },
  'priority': { type: 'reg', target: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\Game.exe\\PerfOptions\\CpuPriorityClass', path: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\Game.exe\\PerfOptions', value: 'CpuPriorityClass', on: '0x3', off: 'missing' },
  'excl-fs': { type: 'reg', target: 'HKCU\\System\\GameConfigStore\\GameDVR_FSEBehaviorMode', path: 'HKCU\\System\\GameConfigStore', value: 'GameDVR_FSEBehaviorMode', on: '0x2', off: '0x0' }
};

async function readVerification(rule) {
  if (!rule) return { ok: false, value: 'not tracked', raw: '' };
  if (rule.type === 'reg') return readReg(rule.path, rule.value);
  if (rule.type === 'power') return readPowerPlan();
  return { ok: false, value: 'not tracked', raw: '' };
}

async function verifiedRun(id, enabled) {
  const entry = tweakCommands[id];
  const rule = verificationRules[id];
  if (!entry) return { id, enabled, ok: true, simulated: true, message: 'No OS command mapped; saved in app state only.', verification: { tracked: false, target: 'App state only', before: 'not tracked', after: 'not tracked', expected: enabled ? 'enabled' : 'disabled', applied: true } };
  const beforeRead = await readVerification(rule);
  const command = enabled ? entry.on : entry.off;
  const result = await run(command);
  const afterRead = await readVerification(rule);
  const expected = rule ? rule[enabled ? 'on' : 'off'] : null;
  const applied = rule ? normCheckValue(afterRead.value) === normCheckValue(expected) : result.ok;
  return {
    id,
    enabled,
    ...result,
    command,
    verification: {
      tracked: !!rule,
      target: rule ? rule.target : 'Command result only',
      before: beforeRead.value,
      after: afterRead.value,
      expected: expected || (enabled ? 'enabled' : 'disabled'),
      applied: !!applied,
      rawBefore: beforeRead.raw || '',
      rawAfter: afterRead.raw || ''
    }
  };
}

ipcMain.handle('apply-tweak', async (_event, tweakId, enabled) => {
  if (process.platform !== 'win32') return { id: tweakId, enabled: !!enabled, ok: true, simulated: true, message: 'Non-Windows system: tweak saved in app state only.', verification: { tracked: false, target: 'Non-Windows system', before: 'not tracked', after: 'not tracked', expected: enabled ? 'enabled' : 'disabled', applied: true } };
  return verifiedRun(tweakId, !!enabled);
});

ipcMain.handle('apply-tweaks-batch', async (_event, changes) => {
  const results = [];
  for (const change of changes || []) {
    const id = change.id;
    const enabled = !!change.enabled;
    if (process.platform !== 'win32') {
      results.push({ id, enabled, ok: true, simulated: true, message: 'Non-Windows system: saved in app state only.', verification: { tracked: false, target: 'Non-Windows system', before: 'not tracked', after: 'not tracked', expected: enabled ? 'enabled' : 'disabled', applied: true } });
      continue;
    }
    results.push(await verifiedRun(id, enabled));
  }
  const undoActions = results.filter(r => r && r.ok).map(r => ({ kind: 'tweak', id: r.id, enabled: !r.enabled }));
  pushUndoGroup('Tweaks batch', undoActions);
  return { ok: results.every(r => r.ok && (!r.verification || r.verification.applied !== false)), results, undoAvailable: undoActions.length > 0 };
});



async function cleanUserTemp() {
  const tempDir = os.tmpdir();
  let removed = 0;
  let skipped = 0;
  try {
    const entries = fs.readdirSync(tempDir, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(tempDir, entry.name);
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 });
        removed++;
      } catch (_) {
        skipped++;
      }
    }
    return {
      ok: true,
      label: 'Clean temp files',
      message: skipped ? `Cleaned ${removed} temp items. Skipped ${skipped} locked/in-use items.` : `Cleaned ${removed} temp items.`
    };
  } catch (err) {
    return { ok: false, label: 'Clean temp files', error: err.message || 'Could not read temp folder.' };
  }
}


function bytesToMb(n) {
  return Math.round((Number(n) || 0) / 1024 / 1024 * 10) / 10;
}

function readDirSize(target, depth = 2) {
  let total = 0;
  let count = 0;
  try {
    for (const item of fs.readdirSync(target, { withFileTypes: true })) {
      const full = path.join(target, item.name);
      try {
        if (item.isDirectory() && depth > 0) {
          const inner = readDirSize(full, depth - 1);
          total += inner.bytes;
          count += inner.items;
        } else if (item.isFile()) {
          const st = fs.statSync(full);
          total += st.size;
          count++;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return { bytes: total, items: count };
}

async function scanJunk() {
  const temp = readDirSize(os.tmpdir(), 3);
  const winTemp = process.platform === 'win32' ? readDirSize('C:\\Windows\\Temp', 2) : { bytes: 0, items: 0 };
  const prefetch = process.platform === 'win32' ? readDirSize('C:\\Windows\\Prefetch', 1) : { bytes: 0, items: 0 };
  const total = temp.bytes + winTemp.bytes + prefetch.bytes;
  const items = temp.items + winTemp.items + prefetch.items;
  return {
    ok: true,
    totalMb: bytesToMb(total),
    items,
    locations: [
      { name: 'User temp', mb: bytesToMb(temp.bytes), items: temp.items },
      { name: 'Windows temp', mb: bytesToMb(winTemp.bytes), items: winTemp.items },
      { name: 'Prefetch cache', mb: bytesToMb(prefetch.bytes), items: prefetch.items }
    ]
  };
}

function memoryTextToMb(value) {
  const n = Number(String(value || '').replace(/[^0-9]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function processGroupKey(name) {
  const base = String(name || '').toLowerCase();
  if (base === 'svchost.exe') return 'svchost.exe';
  if (base === 'chrome.exe' || base === 'msedge.exe' || base === 'firefox.exe' || base === 'brave.exe') return base;
  if (base === 'discord.exe') return 'discord.exe';
  return base;
}

function parseProcessJson(text) {
  try {
    const data = JSON.parse(String(text || '[]'));
    const rows = Array.isArray(data) ? data : [data];
    return rows.map(x => {
      const name = String(x.ProcessName || x.Name || '').trim();
      const exe = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`;
      const pid = String(x.Id || '').trim();
      const memMb = Math.max(0, Math.round(Number(x.WorkingSet64 || 0) / 1024 / 1024));
      return { name: exe, baseName: name, pid, memory: `${memMb} MB`, memoryMb: memMb, path: String(x.Path || ''), cpu: Number(x.CPU || 0) || 0 };
    }).filter(x => x.name && x.pid);
  } catch {
    return [];
  }
}

function buildProcessGroups(rows) {
  const map = new Map();
  rows.forEach(row => {
    const key = processGroupKey(row.name);
    if (!map.has(key)) map.set(key, { key, name: key, count: 0, memoryMb: 0, children: [], path: row.path || '' });
    const group = map.get(key);
    group.count += 1;
    group.memoryMb += row.memoryMb || memoryTextToMb(row.memory);
    if (!group.path && row.path) group.path = row.path;
    group.children.push(row);
  });
  return Array.from(map.values()).map(group => {
    group.memory = `${group.memoryMb} MB`;
    group.children.sort((a, b) => (b.memoryMb || 0) - (a.memoryMb || 0));
    group.displayName = group.count > 1 ? `${group.name} (${group.count})` : group.name;
    group.detail = group.count > 1 ? `${group.count} running · grouped cleanly` : (group.path || 'path unavailable');
    return group;
  }).filter(group => group.name !== 'celestia.exe' && group.name !== 'electron.exe').sort((a, b) => b.memoryMb - a.memoryMb).slice(0, 80);
}

async function getProcesses() {
  if (process.platform !== 'win32') return { ok: true, processes: [], groups: [] };
  const ps = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process | Select-Object ProcessName,Id,WorkingSet64,Path,CPU | ConvertTo-Json -Depth 3 -Compress"`;
  const res = await run(ps, 16000);
  const processes = parseProcessJson(res.stdout);
  return { ok: res.ok, processes, groups: buildProcessGroups(processes), error: res.error || res.stderr || '' };
}

async function setProcessPriority(pid, priority) {
  if (process.platform !== 'win32') return { ok: false, error: 'Process priority is Windows only.' };
  const safePid = Number(pid);
  const allowed = new Set(['Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High']);
  const safePriority = String(priority || 'Normal');
  if (!Number.isInteger(safePid) || safePid < 1) return { ok: false, error: 'Invalid process id.' };
  if (!allowed.has(safePriority)) return { ok: false, error: 'Invalid priority level.' };
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Get-Process -Id ${safePid} -ErrorAction Stop; $p.PriorityClass='${safePriority}'; 'Priority set to '+$p.PriorityClass"`;
  const res = await run(command, 12000);
  if (res.ok) addActivityLog('process', 'Priority changed', `${safePriority} · PID ${safePid}`, { pid: safePid, priority: safePriority });
  return res.ok ? { ok: true, message: `Priority set to ${safePriority}` } : { ok: false, error: res.stderr || res.error || 'Could not set priority. Try running as administrator.' };
}

async function setProcessAffinity(pid, mode) {
  if (process.platform !== 'win32') return { ok: false, error: 'CPU affinity is Windows only.' };
  const safePid = Number(pid);
  const safeMode = String(mode || 'restore');
  if (!Number.isInteger(safePid) || safePid < 1) return { ok: false, error: 'Invalid process id.' };
  const cores = Math.max(1, Math.min((os.cpus() || []).length || 1, 30));
  let mask = Math.pow(2, cores) - 1;
  let label = 'all available cores';
  if (safeMode === 'efficient') {
    const limited = Math.max(1, Math.min(2, cores));
    mask = Math.pow(2, limited) - 1;
    label = `${limited} CPU core${limited === 1 ? '' : 's'}`;
  }
  if (!['efficient', 'restore'].includes(safeMode)) return { ok: false, error: 'Invalid affinity mode.' };
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Get-Process -Id ${safePid} -ErrorAction Stop; $p.ProcessorAffinity=[intptr]${mask}; 'Affinity set'"`;
  const res = await run(command, 12000);
  if (res.ok) addActivityLog('process', 'CPU affinity changed', `${label} · PID ${safePid}`, { pid: safePid, mode: safeMode });
  return res.ok ? { ok: true, message: `CPU affinity set to ${label}` } : { ok: false, error: res.stderr || res.error || 'Could not set CPU affinity. Try running as administrator.' };
}

async function setProcessEcoMode(pid, enabled) {
  if (process.platform !== 'win32') return { ok: false, error: 'Eco mode is Windows only.' };
  const safePid = Number(pid);
  if (!Number.isInteger(safePid) || safePid < 1) return { ok: false, error: 'Invalid process id.' };
  const priority = enabled ? 'BelowNormal' : 'Normal';
  const first = await setProcessPriority(safePid, priority);
  if (!first.ok) return first;
  const second = await setProcessAffinity(safePid, enabled ? 'efficient' : 'restore');
  if (!second.ok) return second;
  addActivityLog('process', enabled ? 'Efficiency mode applied' : 'Efficiency mode removed', `PID ${safePid}`, { pid: safePid, enabled: !!enabled });
  return { ok: true, message: enabled ? 'Efficiency mode applied' : 'Efficiency mode removed' };
}

async function resetNetworkStack() {
  if (process.platform !== 'win32') return { ok: false, error: 'Network reset is Windows only.' };
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -Command netsh winsock reset; netsh int ip reset; ipconfig /flushdns; Write-Host Network reset complete. Restart your PC to finish.; Start-Sleep -Seconds 3'"`;
  const res = await run(command, 12000);
  if (res.ok) {
    addActivityLog('network', 'Network reset started', 'Restart required to finish');
    return { ok: true, restartRequired: true, message: 'Network reset started. Approve the admin prompt, then restart your PC.' };
  }
  return { ok: false, error: 'Windows blocked the admin prompt. Run Celestia as administrator and try again.' };
}

const utilityActions = {
  'flush-dns': { label: 'Flush DNS cache', command: 'ipconfig /flushdns' },
  'clean-temp': { label: 'Clean user temp files', special: 'cleanUserTemp' },
  'restart-explorer': { label: 'Restart Windows Explorer', command: 'taskkill /f /im explorer.exe & start explorer.exe' },
  'open-startup': { label: 'Open Startup Apps settings', command: 'start ms-settings:startupapps' },
  'open-power': { label: 'Open Power settings', command: 'start ms-settings:powersleep' },
  'create-restore': { label: 'Create restore point', command: PS + '"Checkpoint-Computer -Description Celestia-Before-Tweaks -RestorePointType MODIFY_SETTINGS"', timeout: 60000 },
  'clear-recycle': { label: 'Empty Recycle Bin', command: PS + '"Clear-RecycleBin -Force -ErrorAction SilentlyContinue"', timeout: 60000 },
  'network-reset': { label: 'Reset network stack', special: 'networkReset', timeout: 60000 },
  'open-disk-cleanup': { label: 'Open Disk Cleanup', command: 'cleanmgr' },
  'open-services': { label: 'Open Services', command: 'services.msc' },
  'open-device-manager': { label: 'Open Device Manager', command: 'devmgmt.msc' },
  'sfc-scan': { label: 'System file check', command: 'sfc /scannow', timeout: 180000 }
};

ipcMain.handle('run-utility-action', async (_event, actionId) => {
  if (process.platform !== 'win32') return { ok: true, simulated: true, message: 'Non-Windows system: action unavailable.' };
  const action = utilityActions[actionId];
  if (!action) return { ok: false, error: 'Unknown utility action.' };
  if (action.special === 'cleanUserTemp') return cleanUserTemp();
  if (action.special === 'networkReset') return resetNetworkStack();
  const result = await run(action.command, action.timeout || 15000);
  return { ...result, label: action.label };
});


ipcMain.handle('scan-junk', async () => scanJunk());
ipcMain.handle('get-processes', async () => getProcesses());
ipcMain.handle('set-process-priority', async (_event, pid, priority) => setProcessPriority(pid, priority));
ipcMain.handle('set-process-affinity', async (_event, pid, mode) => setProcessAffinity(pid, mode));
ipcMain.handle('set-process-eco-mode', async (_event, pid, enabled) => setProcessEcoMode(pid, enabled));
ipcMain.handle('get-startup-items', async () => listStartupItems());
ipcMain.handle('set-startup-item', async (_event, id, enabled) => setStartupItem(id, !!enabled));
ipcMain.handle('get-activity-log', async () => ({ ok: true, rows: readActivityLog() }));
ipcMain.handle('add-activity-log', async (_event, entry) => ({ ok: true, row: addActivityLog(entry && entry.type, entry && entry.title, entry && entry.detail, entry && entry.meta) }));
ipcMain.handle('clear-activity-log', async () => clearActivityLog());
ipcMain.handle('kill-process', async (_event, pid) => {
  if (process.platform !== 'win32') return { ok: false, error: 'Process control is Windows only.' };
  const safePid = String(pid || '').replace(/\D/g, '');
  if (!safePid) return { ok: false, error: 'Invalid process id.' };
  const res = await run(`taskkill /PID ${safePid} /F`, 15000);
  return res.ok ? { ok: true, message: `Closed process ${safePid}` } : { ok: false, error: res.stderr || res.error || 'Could not close process.' };
});


const serviceBoostList = [
  { id: 'SysMain', name: 'SysMain', label: 'SysMain', recommended: 'disabled', reason: 'Reduces background disk and memory preloading on SSD systems.' },
  { id: 'DiagTrack', name: 'DiagTrack', label: 'Connected User Experiences', recommended: 'disabled', reason: 'Cuts diagnostic telemetry background activity.' },
  { id: 'WSearch', name: 'WSearch', label: 'Windows Search', recommended: 'manual', reason: 'Keeps search available while reducing always-on indexing.' },
  { id: 'XboxGipSvc', name: 'XboxGipSvc', label: 'Xbox Accessory Management', recommended: 'manual', reason: 'Only needed for Xbox accessories and controllers.' },
  { id: 'XblAuthManager', name: 'XblAuthManager', label: 'Xbox Live Auth Manager', recommended: 'manual', reason: 'Only needed for Xbox services and Game Pass sign-in.' },
  { id: 'XboxNetApiSvc', name: 'XboxNetApiSvc', label: 'Xbox Live Networking', recommended: 'manual', reason: 'Only needed for Xbox network features.' },
  { id: 'MapsBroker', name: 'MapsBroker', label: 'Downloaded Maps Manager', recommended: 'disabled', reason: 'Useful only for offline map downloads.' },
  { id: 'Fax', name: 'Fax', label: 'Fax', recommended: 'disabled', reason: 'Legacy service rarely used on modern desktops.' }
];

function parseScQuery(text) {
  const state = String(text || '').match(/STATE\s*:\s*\d+\s+(\w+)/i);
  return state ? state[1].toLowerCase() : 'unknown';
}

function parseScQc(text) {
  const start = String(text || '').match(/START_TYPE\s*:\s*\d+\s+([\w_]+)/i);
  const raw = start ? start[1].toLowerCase() : 'unknown';
  if (raw.includes('disabled')) return 'disabled';
  if (raw.includes('demand')) return 'manual';
  if (raw.includes('auto')) return 'auto';
  return raw;
}

async function readService(item) {
  const q = await run(`sc query "${item.name}"`, 10000);
  const c = await run(`sc qc "${item.name}"`, 10000);
  return { ...item, exists: q.ok || c.ok, state: q.ok ? parseScQuery(q.stdout) : 'missing', start: c.ok ? parseScQc(c.stdout) : 'missing' };
}

async function listBoostServices() {
  if (process.platform !== 'win32') return { ok: true, services: serviceBoostList.map(x => ({ ...x, exists: false, state: 'unavailable', start: 'unavailable' })) };
  const services = [];
  for (const item of serviceBoostList) services.push(await readService(item));
  return { ok: true, services };
}

async function setServiceMode(id, mode, skipUndo) {
  if (process.platform !== 'win32') return { ok: true, simulated: true, message: 'Non-Windows system: service mode saved only.' };
  const item = serviceBoostList.find(x => x.id === id || x.name === id);
  if (!item) return { ok: false, error: 'Unknown service.' };
  if (!['disabled', 'manual', 'auto'].includes(mode)) return { ok: false, error: 'Invalid service mode.' };
  const before = await readService(item);
  const scMode = mode === 'manual' ? 'demand' : mode;
  const config = await run(`sc config "${item.name}" start= ${scMode}`, 15000);
  let stop = { ok: true };
  if (mode === 'disabled') stop = await run(`sc stop "${item.name}"`, 15000);
  const after = await readService(item);
  const ok = config.ok && after.start === mode;
  if (ok && !skipUndo && before && before.start && before.start !== mode) pushUndoGroup('Service change', [{ kind: 'service', id: item.id, mode: before.start }]);
  return { ok, id:item.id, label:item.label, before, after, mode, needsRestart: true, message: ok ? `${item.label} set to ${mode}.` : (config.stderr || stop.stderr || config.error || 'Service update failed.') };
}

async function applyServiceBoost() {
  const results = [];
  for (const item of serviceBoostList) results.push(await setServiceMode(item.id, item.recommended, true));
  const undoActions = results.filter(x => x && x.ok && x.before && x.before.start && x.before.start !== x.mode).map(x => ({ kind: 'service', id: x.id, mode: x.before.start }));
  pushUndoGroup('Service boost', undoActions);
  return { ok: results.every(x => x.ok), results, needsRestart: results.some(x => x.needsRestart), undoAvailable: undoActions.length > 0 };
}

ipcMain.handle('get-services', async () => listBoostServices());
ipcMain.handle('set-service-mode', async (_event, id, mode) => setServiceMode(id, mode));
ipcMain.handle('apply-service-boost', async () => applyServiceBoost());

ipcMain.on('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-maximize', () => { if (mainWindow) mainWindow.isMaximized() ? mainWindow.restore() : mainWindow.maximize(); });
ipcMain.on('window-close', () => { if (mainWindow) mainWindow.close(); });
