const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

const REPO = 'ApriamAsh/SocialAutism';
let win;
let downloadState = { busy: false, received: 0, total: 0 };

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Social-Atlas-Launcher', ...headers } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(request(res.headers.location, headers));
      }
      if (res.statusCode !== 200) {
        res.resume(); return reject(new Error('GitHub returned HTTP ' + res.statusCode));
      }
      resolve(res);
    });
    req.setTimeout(30000, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}
async function getLatestRelease() {
  const response = await request('https://api.github.com/repos/' + REPO + '/releases/latest', { Accept: 'application/vnd.github+json' });
  let body = '';
  for await (const chunk of response) body += chunk;
  const release = JSON.parse(body);
  const installer = release.assets?.find(a => /^Social-Atlas-Setup-.*\.exe$/i.test(a.name));
  if (!release.tag_name || !installer) throw new Error('No published Social Atlas installer was found in the latest GitHub release.');
  return { version: release.tag_name, name: release.name || release.tag_name, url: installer.browser_download_url, releaseUrl: release.html_url, size: installer.size };
}
function installPath() {
  return path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Programs', 'Social Atlas', 'Social Atlas.exe');
}
function installed() { return fs.existsSync(installPath()); }
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

ipcMain.handle('launcher:status', async () => {
  let release;
  try { release = await getLatestRelease(); }
  catch (e) { return { ok: false, installed: installed(), installPath: installPath(), error: e.message }; }
  return { ok: true, installed: installed(), installPath: installPath(), version: release.version, releaseName: release.name, releaseUrl: release.releaseUrl, size: release.size, busy: downloadState.busy };
});
ipcMain.handle('launcher:open-release', async () => shell.openExternal('https://github.com/' + REPO + '/releases'));
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
    const response = await request(release.url, { Accept: 'application/octet-stream' });
    downloadState.total = Number(response.headers['content-length']) || release.size || 0;
    const out = fs.createWriteStream(temp);
    await new Promise((resolve, reject) => {
      response.on('data', chunk => {
        downloadState.received += chunk.length;
        const percent = downloadState.total ? Math.min(100, Math.round(downloadState.received / downloadState.total * 100)) : 0;
        send('launcher:progress', { phase: 'download', percent, message: 'Downloading Social Atlas… ' + percent + '%' });
      });
      response.on('error', reject); out.on('error', reject); out.on('finish', resolve);
      response.pipe(out);
    });
    fs.renameSync(temp, final);
    send('launcher:progress', { phase: 'install', percent: 100, message: 'Opening the installer…' });
    await new Promise((resolve, reject) => {
      const child = spawn(final, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', reject); child.unref(); resolve();
    });
    send('launcher:progress', { phase: 'done', percent: 100, message: 'Installer opened. Finish its steps, then click Launch Social Atlas.' });
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
