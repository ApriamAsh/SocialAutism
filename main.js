const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const REPO = 'ApriamAsh/SocialAutism';
const UPDATE_FILES = ['index.html', 'styles.css'];
const updateDir = () => path.join(app.getPath('userData'), 'source-updates');
let mainWindow;

function requestText(url, accept = 'text/plain') {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Social-Atlas-Updater', 'Accept': accept } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(requestText(res.headers.location, accept));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('Update server returned HTTP ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.setTimeout(30000, () => req.destroy(new Error('Update request timed out')));
    req.on('error', reject);
  });
}

async function latestRelease() {
  const json = await requestText('https://api.github.com/repos/' + REPO + '/releases/latest', 'application/vnd.github+json');
  const release = JSON.parse(json);
  if (!release.tag_name || !Array.isArray(release.assets)) throw new Error('No published Social Atlas release was found');
  const bundle = release.assets.find(asset => asset.name === 'renderer.bundle.js');
  if (!bundle) throw new Error('The latest release does not contain the app update bundle yet');
  return { tag: release.tag_name, bundleUrl: bundle.browser_download_url, htmlUrl: release.html_url };
}

function getAppliedVersion() {
  try { return fs.readFileSync(path.join(updateDir(), 'source-version.txt'), 'utf8').trim(); }
  catch { return ''; }
}

ipcMain.handle('updates:check', async () => {
  try {
    const latest = await latestRelease();
    return { ok: true, latest: latest.tag, current: getAppliedVersion(), updateAvailable: latest.tag !== getAppliedVersion(), releaseUrl: latest.htmlUrl };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

ipcMain.handle('updates:apply', async () => {
  try {
    const latest = await latestRelease();
    const dir = updateDir();
    const staging = dir + '-staging';
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    for (const file of UPDATE_FILES) {
      const content = await requestText('https://raw.githubusercontent.com/' + REPO + '/' + encodeURIComponent(latest.tag) + '/' + file);
      if (!content || content.length < 20) throw new Error('Downloaded an invalid ' + file);
      if (file === 'index.html' && !content.includes('renderer.bundle.js')) throw new Error('Downloaded index.html failed validation');
      fs.writeFileSync(path.join(staging, file), content, 'utf8');
    }
    const bundle = await requestText(latest.bundleUrl);
    if (!bundle || bundle.length < 100000) throw new Error('Downloaded app bundle failed validation');
    fs.writeFileSync(path.join(staging, 'renderer.bundle.js'), bundle, 'utf8');
    fs.writeFileSync(path.join(staging, 'source-version.txt'), latest.tag, 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadFile(path.join(dir, 'index.html'));
    return { ok: true, version: latest.tag };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 650,
    title: 'Social Atlas',
    backgroundColor: '#11151c',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.js') }
  });
  const updatedIndex = path.join(updateDir(), 'index.html');
  mainWindow.loadFile(fs.existsSync(updatedIndex) ? updatedIndex : path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
