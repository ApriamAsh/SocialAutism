const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

const REPO = 'ApriamAsh/SocialAutism';
const API = 'https://api.github.com/repos/' + REPO;
const RELEASES_PAGE = 'https://github.com/' + REPO + '/releases';
let win;
let downloadState = { busy: false, received: 0, total: 0 };

function request(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects while contacting GitHub.'));
    const target = new URL(url);
    if (target.protocol !== 'https:') return reject(new Error('Refusing non-HTTPS update URL.'));
    const req = https.get(target, {
      headers: { 'User-Agent': 'Social-Atlas-Launcher/1.0', 'Accept': 'application/vnd.github+json', ...headers }
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, target).toString();
        // Never forward GitHub API-specific headers to a different host.
        const nextHeaders = new URL(next).hostname === target.hostname ? headers : {};
        return resolve(request(next, nextHeaders, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('GitHub HTTP ' + res.statusCode + ' while requesting ' + target.pathname + '.'));
      }
      resolve(res);
    });
    req.setTimeout(45000, () => req.destroy(new Error('GitHub request timed out. Check your connection and try again.')));
    req.on('error', reject);
  });
}

async function readJson(url) {
  const response = await request(url);
  let body = '';
  for await (const chunk of response) body += chunk;
  try { return JSON.parse(body); }
  catch { throw new Error('GitHub returned an invalid release response.'); }
}

function selectRelease(releases) {
  const usable = releases.find(release => {
    if (!release || release.draft || release.prerelease || !release.tag_name || !Array.isArray(release.assets)) return false;
    return release.assets.some(asset => /^Social-Atlas-Setup-.*\.exe$/i.test(asset.name) && asset.browser_download_url);
  });
  if (!usable) throw new Error('No published release containing the Social Atlas Windows installer was found.');
  const installer = usable.assets.find(asset => /^Social-Atlas-Setup-.*\.exe$/i.test(asset.name) && asset.browser_download_url);
  return { version: usable.tag_name, name: usable.name || usable.tag_name, url: installer.browser_download_url, releaseUrl: usable.html_url || RELEASES_PAGE, size: installer.size || 0 };
}

async function getLatestRelease() {
  // Prefer the canonical latest endpoint; fall back to the release list if GitHub/CDN
  // intermittently returns 404 for /releases/latest.
  try {
    const latest = await readJson(API + '/releases/latest');
    return selectRelease([latest]);
  } catch (latestError) {
    try {
      const list = await readJson(API + '/releases?per_page=20');
      if (!Array.isArray(list)) throw new Error('GitHub release list was not an array.');
      return selectRelease(list);
    } catch (listError) {
      throw new Error('Could not find the latest Social Atlas release. ' + latestError.message + ' Fallback: ' + listError.message + ' Open GitHub Releases to check availability.');
    }
  }
}

function installPath() {
  return path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Programs', 'Social Atlas', 'Social Atlas.exe');
}
function installed() { return fs.existsSync(installPath()); }
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

ipcMain.handle('launcher:status', async () => {
  try {
    const release = await getLatestRelease();
    return { ok: true, installed: installed(), installPath: installPath(), version: release.version, releaseName: release.name, releaseUrl: release.releaseUrl, size: release.size, busy: downloadState.busy };
  } catch (e) {
    return { ok: false, installed: installed(), installPath: installPath(), error: e.message, releaseUrl: RELEASES_PAGE };
  }
});
ipcMain.handle('launcher:open-release', async () => shell.openExternal(RELEASES_PAGE));
ipcMain.handle('launcher:launch', async () => {
  const target = installPath();
  if (!fs.existsSync(target)) return { ok: false, message: 'Social Atlas is not installed yet. Use Install / Update first.' };
  const child = spawn(target, [], { detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true };
});

ipcMain.handle('launcher:install', async () => {
  if (downloadState.busy) return { ok: false, message: 'A download is already running.' };
  downloadState = { busy: true, received: 0, total: 0 };
  send('launcher:progress', { phase: 'checking', percent: 0, message: 'Checking latest GitHub release…' });
  let temp;
  try {
    const release = await getLatestRelease();
    const downloads = path.join(app.getPath('userData'), 'downloads');
    fs.mkdirSync(downloads, { recursive: true });
    temp = path.join(downloads, 'Social-Atlas-Setup.exe.part');
    const final = path.join(downloads, 'Social-Atlas-Setup.exe');
    try { fs.rmSync(temp, { force: true }); } catch {}
    const response = await request(release.url, { Accept: 'application/octet-stream' });
    downloadState.total = Number(response.headers['content-length']) || release.size || 0;
    const out = fs.createWriteStream(temp);
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        out.destroy();
        reject(error);
      };
      response.on('data', chunk => {
        downloadState.received += chunk.length;
        const percent = downloadState.total ? Math.min(100, Math.round(downloadState.received / downloadState.total * 100)) : 0;
        send('launcher:progress', { phase: 'download', percent, message: 'Downloading Social Atlas… ' + percent + '%' });
      });
      response.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => out.close(error => {
        if (error) return fail(error);
        if (settled) return;
        settled = true;
        resolve();
      }));
      response.pipe(out);
    });
    const actualSize = fs.statSync(temp).size;
    if (actualSize < 1000000 || (release.size && actualSize !== release.size)) {
      throw new Error('The downloaded installer failed its size check (' + actualSize + ' bytes). Nothing was installed; please retry.');
    }
    fs.rmSync(final, { force: true });
    fs.renameSync(temp, final);
    temp = null;
    send('launcher:progress', { phase: 'install', percent: 100, message: 'Opening Social Atlas installer…' });
    const child = spawn(final, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', error => send('launcher:progress', { phase: 'error', percent: 0, message: 'Could not open installer: ' + error.message }));
    child.unref();
    send('launcher:progress', { phase: 'done', percent: 100, message: 'Installer opened. Complete its steps, then click Launch Social Atlas.' });
    return { ok: true, version: release.version, message: 'Installer downloaded and opened.' };
  } catch (error) {
    if (temp) try { fs.rmSync(temp, { force: true }); } catch {}
    send('launcher:progress', { phase: 'error', percent: 0, message: error.message });
    return { ok: false, message: error.message };
  } finally {
    downloadState.busy = false;
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1080, height: 760, minWidth: 860, minHeight: 640,
    title: 'Social Atlas Launcher',
    backgroundColor: '#070b15',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.js') }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => { win = null; });
}
app.whenReady().then(() => {
  app.setAppUserModelId('com.darkfyre.socialatlas.launcher');
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
