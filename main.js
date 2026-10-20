const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const REPO = 'ApriamAsh/SocialAutism';
const BRANCH = 'main';
const UPDATE_FILES = ['index.html', 'styles.css', 'renderer.bundle.js'];
const updateDir = () => path.join(app.getPath('userData'), 'source-updates');
let mainWindow;

function requestText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Social-Atlas-Updater', 'Accept': 'application/vnd.github+json' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(requestText(res.headers.location));
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
    req.setTimeout(20000, () => req.destroy(new Error('Update request timed out')));
    req.on('error', reject);
  });
}

async function latestCommit() {
  const json = await requestText('https://api.github.com/repos/' + REPO + '/commits/' + BRANCH);
  const parsed = JSON.parse(json);
  if (!parsed.sha) throw new Error('Could not read latest source version');
  return parsed.sha;
}

function getAppliedCommit() {
  try { return fs.readFileSync(path.join(updateDir(), 'source-commit.txt'), 'utf8').trim(); }
  catch { return ''; }
}

ipcMain.handle('updates:check', async () => {
  try {
    const latest = await latestCommit();
    return { ok: true, latest, current: getAppliedCommit(), updateAvailable: latest !== getAppliedCommit() };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

ipcMain.handle('updates:apply', async () => {
  try {
    const latest = await latestCommit();
    const dir = updateDir();
    const staging = dir + '-staging';
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    for (const file of UPDATE_FILES) {
      const content = await requestText('https://raw.githubusercontent.com/' + REPO + '/' + latest + '/' + file);
      if (!content || content.length < 20) throw new Error('Downloaded an invalid ' + file);
      if (file === 'index.html' && !content.includes('renderer.bundle.js')) throw new Error('Downloaded index.html failed validation');
      fs.writeFileSync(path.join(staging, file), content, 'utf8');
    }
    fs.writeFileSync(path.join(staging, 'source-commit.txt'), latest, 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadFile(path.join(dir, 'index.html'));
    }
    return { ok: true, commit: latest };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 650,
    title: 'Social Atlas',
    backgroundColor: '#11151c',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
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
