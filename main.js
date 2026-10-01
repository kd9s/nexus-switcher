const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, safeStorage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { exec } = require('child_process');

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
// Removed explicit disk-cache-dir to prevent access denied errors

let mainWindow;
let tray = null;
let isQuitting = false;
let trayLang = 'ar';

const TRAY_LABELS = {
  ar: { open: 'فتح Nexus Switcher', quit: 'إغلاق البرنامج' },
  en: { open: 'Open Nexus Switcher', quit: 'Quit' }
};

const SESSIONS_DIR = path.join(app.getPath('userData'), 'PlatformSessions');
const PLATFORM_ACTIVE_STATE_PATH = path.join(app.getPath('userData'), 'nexus-data', 'platform-active.json');

function readPlatformActiveState() {
    try {
        if (fs.existsSync(PLATFORM_ACTIVE_STATE_PATH)) {
            return JSON.parse(fs.readFileSync(PLATFORM_ACTIVE_STATE_PATH, 'utf-8'));
        }
    } catch (e) {}
    return {};
}

function writePlatformActiveState(state) {
    try {
        const dir = path.dirname(PLATFORM_ACTIVE_STATE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(PLATFORM_ACTIVE_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
    } catch (e) {}
}
const LOCAL_APPDATA = path.join(os.homedir(), 'AppData', 'Local');
const ROAMING_APPDATA = path.join(os.homedir(), 'AppData', 'Roaming');

// Epic session paths (aligned with TcNo Account Switcher Platforms.json)
const EPIC_SAVED_DIR = path.join(LOCAL_APPDATA, 'EpicGamesLauncher', 'Saved');
const EPIC_CONFIG_DIR = path.join(EPIC_SAVED_DIR, 'Config');
// The Epic Games Launcher stores its login RememberMe token in Config\Windows\.
// WindowsEditor\ belongs to the Unreal Engine editor and can hold a DIFFERENT
// (stale) token, so Windows must be preferred as the authoritative source.
const EPIC_GAME_USER_SETTINGS = [
    path.join(EPIC_CONFIG_DIR, 'Windows', 'GameUserSettings.ini'),
    path.join(EPIC_CONFIG_DIR, 'WindowsEditor', 'GameUserSettings.ini')
];
// Epic Games Launcher's own namespace id (same for everyone, NOT a user account id)
const EPIC_LAUNCHER_NAMESPACE_ID = '680103d77ecd4944a13f2a06af3b034e';
const EPIC_REGISTRY = {
    hive: 'HKCU',
    key: 'Software\\Epic Games\\Unreal Engine\\Identifiers',
    valueName: 'AccountId'
};
const EPIC_CACHE_PATHS = [
    path.join(LOCAL_APPDATA, 'Epic Games', 'Epic Online Services', 'UI Helper', 'Cache', 'Cache'),
    path.join(LOCAL_APPDATA, 'Epic Games', 'Epic Online Services', 'UI Helper', 'Cache', 'GPUCache'),
    path.join(LOCAL_APPDATA, 'Epic Games', 'EOSOverlay', 'BrowserCache', 'Cache')
];

const PLATFORM_INFO = {
    epic: {
        process: 'EpicGamesLauncher.exe',
        kill: [
            'EpicGamesLauncher.exe',
            'EpicWebHelper.exe',
            'EpicOnlineServicesUserHelper.exe',
            'EpicOnlineServicesHost.exe',
            'EpicOnlineServices.exe',
            'CEFProcess.exe'
        ],
        killDelayMs: 4500,
        launchDelayMs: 2000,
        useTcNoStyle: true,
        // Legacy full-folder backups (older Nexus versions)
        sessionRoots: [
            { slot: 'Saved', path: path.join(LOCAL_APPDATA, 'EpicGamesLauncher', 'Saved') },
            { slot: 'Intermediate', path: path.join(LOCAL_APPDATA, 'EpicGamesLauncher', 'Intermediate') },
            { slot: 'EpicRoaming', path: path.join(ROAMING_APPDATA, 'Epic') }
        ]
    },
    riot: {
        process: 'RiotClientServices.exe',
        kill: ['RiotClientServices.exe', 'RiotClientUx.exe', 'RiotClientCrashHandler.exe'],
        killDelayMs: 2000,
        launchDelayMs: 800,
        sessionRoots: [{ slot: 'Data', path: path.join(LOCAL_APPDATA, 'Riot Games', 'Riot Client', 'Data') }]
    },
    ea: {
        process: 'EADesktop.exe',
        kill: ['EADesktop.exe', 'EABackgroundService.exe', 'Link2EA.exe'],
        killDelayMs: 2500,
        launchDelayMs: 1000,
        sessionRoots: [{ slot: 'EADesktop', path: path.join(LOCAL_APPDATA, 'Electronic Arts', 'EA Desktop') }]
    },
    ubisoft: {
        process: 'upc.exe',
        kill: ['upc.exe', 'UplayWebCore.exe', 'UbisoftGameLauncher.exe'],
        killDelayMs: 2000,
        launchDelayMs: 800,
        sessionRoots: [{ slot: 'Main', path: path.join(LOCAL_APPDATA, 'Ubisoft Game Launcher') }]
    },
    battlenet: {
        process: 'Battle.net.exe',
        kill: ['Battle.net.exe', 'Agent.exe', 'Battle.net Launcher.exe'],
        killDelayMs: 2000,
        launchDelayMs: 800,
        sessionRoots: [{ slot: 'Main', path: path.join(ROAMING_APPDATA, 'Battle.net') }]
    }
};

function getSessionRoots(info) {
    if (info.sessionRoots && info.sessionRoots.length) return info.sessionRoots;
    if (info.path) return [{ slot: 'main', path: info.path }];
    return [];
}

function isSafeAccountName(name) {
    if (!name || name === '.' || name === '..') return false;
    if (name.length > 80) return false;
    if (/[<>:"/\\|?*\u0000-\u001F]/.test(name)) return false;
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(name)) return false;
    return true;
}

function sessionSlotDir(platform, accountName) {
    if (!PLATFORM_INFO[platform]) throw new Error('Unknown platform.');
    const name = String(accountName || '').trim();
    if (!isSafeAccountName(name)) throw new Error('Invalid account name.');
    const base = path.resolve(SESSIONS_DIR, platform);
    const target = path.resolve(base, name);
    const rel = path.relative(base, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Invalid account name.');
    return target;
}

function findEpicLauncherExe() {
    const candidates = [
        path.join('C:', 'Program Files (x86)', 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe'),
        path.join('C:', 'Program Files (x86)', 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win32', 'EpicGamesLauncher.exe'),
        path.join('C:', 'Program Files', 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function launchPlatformAppMain(platform) {
    if (platform === 'epic') {
        const exe = findEpicLauncherExe();
        if (exe) {
            exec(`start "" "${exe}"`);
            return;
        }
        exec('start com.epicgames.launcher://');
        return;
    }
    if (platform === 'ea') {
        const eaPath = path.join('C:', 'Program Files', 'Electronic Arts', 'EA Desktop', 'EA Desktop', 'EADesktop.exe');
        if (fs.existsSync(eaPath)) {
            exec(`start "" "${eaPath}"`);
            return;
        }
        exec('start origin2://');
        return;
    }
    if (platform === 'riot') {
        const riotPath = path.join('C:', 'Riot Games', 'Riot Client', 'RiotClientServices.exe');
        if (fs.existsSync(riotPath)) {
            exec(`start "" "${riotPath}"`);
            return;
        }
        exec('start riotclient://');
        return;
    }
    if (platform === 'ubisoft') {
        exec('start uplay://');
        return;
    }
    if (platform === 'battlenet') {
        exec('start battlenet://');
    }
}

const fsp = fs.promises;

function sendSessionProgress(platform, message) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('platform-session-progress', { platform, message });
    }
}

async function removePathSafe(targetPath) {
    if (!fs.existsSync(targetPath)) return;
    await fsp.rm(targetPath, { recursive: true, force: true });
}

async function copyTreeAsync(src, dest) {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.cp(src, dest, { recursive: true, force: true });
}

function execAsync(cmd) {
    return new Promise((resolve) => exec(cmd, () => resolve()));
}

async function readRegistryString(hive, keyPath, valueName) {
    return new Promise((resolve) => {
        exec(`reg query "${hive}\\${keyPath}" /v "${valueName}"`, (err, stdout) => {
            if (err) return resolve(null);
            const line = stdout.split('\n').find(l => l.includes(valueName));
            if (!line) return resolve(null);
            const parts = line.trim().split(/\s{2,}/);
            if (parts.length >= 3) return resolve(parts.slice(2).join(' ').trim());
            resolve(null);
        });
    });
}

async function writeRegistryString(hive, keyPath, valueName, data) {
    const safe = String(data).replace(/"/g, '\\"');
    await execAsync(`reg add "${hive}\\${keyPath}" /v "${valueName}" /t REG_SZ /d "${safe}" /f`);
}

function findEpicGameUserSettingsPath() {
    for (const p of EPIC_GAME_USER_SETTINGS) {
        if (fs.existsSync(p)) return p;
    }
    return EPIC_GAME_USER_SETTINGS[0];
}

async function clearEpicCaches() {
    for (const p of EPIC_CACHE_PATHS) {
        try {
            await removePathSafe(p);
        } catch (e) {
            console.error('[epic] cache clear failed:', p, e.message);
        }
    }
}

// Clear Epic launcher web cache (cookies). This forces Epic to re-authenticate
// silently using the restored RememberMe token instead of stale browser cookies.
async function clearEpicWebCaches() {
    try {
        if (!fs.existsSync(EPIC_SAVED_DIR)) return;
        const entries = await fsp.readdir(EPIC_SAVED_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.toLowerCase().startsWith('webcache')) {
                await removePathSafe(path.join(EPIC_SAVED_DIR, entry.name));
            }
        }
    } catch (e) {
        console.error('[epic] webcache clear failed:', e.message);
    }
}

// Derive the user's Epic AccountId from an old folder-style backup by inspecting
// Saved/Data/OC_<accountId>.dat filenames (excluding the launcher namespace id).
function deriveEpicAccountIdFromBackup(sourceDir) {
    const dataDir = path.join(sourceDir, 'Saved', 'Data');
    try {
        if (!fs.existsSync(dataDir)) return null;
        const files = fs.readdirSync(dataDir);
        const ids = new Set();
        for (const f of files) {
            const m = f.match(/^OC_([0-9a-fA-F]{32})\.dat$/);
            if (m && m[1].toLowerCase() !== EPIC_LAUNCHER_NAMESPACE_ID) {
                ids.add(m[1]);
            }
        }
        const list = [...ids];
        return list.length === 1 ? list[0] : null;
    } catch (e) {
        return null;
    }
}

// Unified Epic restore: handles both the new TcNo-style backups and old
// folder-style backups, always restoring token + registry AccountId and
// clearing caches/webcache so the account actually signs in.
async function restoreEpicUnified(sourceDir, platform) {
    let restored = 0;

    await clearEpicCaches();

    const isTcNo = fs.existsSync(path.join(sourceDir, 'Config')) ||
        fs.existsSync(path.join(sourceDir, 'GameUserSettings.ini')) ||
        fs.existsSync(path.join(sourceDir, 'registry', 'AccountId.json'));

    // 1) Restore the Config folder (contains GameUserSettings.ini with tokens)
    let configRestored = false;
    const configBackup = isTcNo
        ? path.join(sourceDir, 'Config')
        : path.join(sourceDir, 'Saved', 'Config');
    if (fs.existsSync(configBackup)) {
        sendSessionProgress(platform, 'restoring-config');
        await removePathSafe(EPIC_CONFIG_DIR);
        await copyTreeAsync(configBackup, EPIC_CONFIG_DIR);
        configRestored = true;
        restored++;
    }

    // 2) Legacy fallback ONLY: reconstruct GameUserSettings.ini from a standalone
    // copy for old backups that have no full Config folder. When the Config folder
    // was restored above, Windows\ and WindowsEditor\ are already exact copies of
    // what was saved — those two files legitimately hold DIFFERENT tokens, so
    // cross-mirroring one over both would overwrite the launcher's real RememberMe
    // token in Windows\ and break auto-login. Hence we skip the mirror in that case.
    if (!configRestored) {
        let iniBackup = null;
        if (fs.existsSync(path.join(sourceDir, 'GameUserSettings.ini'))) {
            iniBackup = path.join(sourceDir, 'GameUserSettings.ini');
        } else if (fs.existsSync(path.join(sourceDir, 'Saved', 'Config', 'Windows', 'GameUserSettings.ini'))) {
            iniBackup = path.join(sourceDir, 'Saved', 'Config', 'Windows', 'GameUserSettings.ini');
        } else if (fs.existsSync(path.join(sourceDir, 'Saved', 'Config', 'WindowsEditor', 'GameUserSettings.ini'))) {
            iniBackup = path.join(sourceDir, 'Saved', 'Config', 'WindowsEditor', 'GameUserSettings.ini');
        }
        if (iniBackup) {
            sendSessionProgress(platform, 'restoring-ini');
            for (const dest of EPIC_GAME_USER_SETTINGS) {
                await fsp.mkdir(path.dirname(dest), { recursive: true });
                await copyTreeAsync(iniBackup, dest);
            }
            restored++;
        }
    }

    // 3) Restore registry AccountId (from new backup, else derive from old backup)
    let accountId = null;
    const regFile = path.join(sourceDir, 'registry', 'AccountId.json');
    if (fs.existsSync(regFile)) {
        try {
            accountId = JSON.parse(await fsp.readFile(regFile, 'utf-8')).value || null;
        } catch (e) {}
    }
    if (!accountId) {
        accountId = deriveEpicAccountIdFromBackup(sourceDir);
    }
    if (accountId) {
        sendSessionProgress(platform, 'restoring-registry');
        await writeRegistryString(
            EPIC_REGISTRY.hive,
            EPIC_REGISTRY.key,
            EPIC_REGISTRY.valueName,
            accountId
        );
        restored++;
    }

    const dataBackup = isTcNo
        ? path.join(sourceDir, 'Data')
        : path.join(sourceDir, 'Saved', 'Data');
    if (fs.existsSync(dataBackup)) {
        sendSessionProgress(platform, 'restoring-data');
        const liveData = path.join(EPIC_SAVED_DIR, 'Data');
        await removePathSafe(liveData);
        await copyTreeAsync(dataBackup, liveData);
        restored++;
    }

    // 4) Clear web cache cookies so Epic re-auths with the restored token
    sendSessionProgress(platform, 'clearing-webcache');
    await clearEpicWebCaches();

    return restored;
}

async function saveEpicSessionTcNo(targetDir, platform) {
    let saved = 0;
    await fsp.mkdir(targetDir, { recursive: true });

    const iniSrc = findEpicGameUserSettingsPath();
    if (fs.existsSync(iniSrc)) {
        sendSessionProgress(platform, 'saving-ini');
        await copyTreeAsync(iniSrc, path.join(targetDir, 'GameUserSettings.ini'));
        saved++;
    }

    if (fs.existsSync(EPIC_CONFIG_DIR)) {
        sendSessionProgress(platform, 'saving-config');
        const destConfig = path.join(targetDir, 'Config');
        await removePathSafe(destConfig);
        await copyTreeAsync(EPIC_CONFIG_DIR, destConfig);
        saved++;
    }

    const accountId = await readRegistryString(
        EPIC_REGISTRY.hive,
        EPIC_REGISTRY.key,
        EPIC_REGISTRY.valueName
    );
    if (accountId) {
        sendSessionProgress(platform, 'saving-registry');
        const regDir = path.join(targetDir, 'registry');
        await fsp.mkdir(regDir, { recursive: true });
        await fsp.writeFile(
            path.join(regDir, 'AccountId.json'),
            JSON.stringify({ value: accountId }, null, 2),
            'utf-8'
        );
        saved++;
    }

    const epicDataDir = path.join(EPIC_SAVED_DIR, 'Data');
    if (fs.existsSync(epicDataDir)) {
        sendSessionProgress(platform, 'saving-data');
        const destData = path.join(targetDir, 'Data');
        await removePathSafe(destData);
        await copyTreeAsync(epicDataDir, destData);
        saved++;
    }

    await fsp.writeFile(
        path.join(targetDir, 'epic-meta.json'),
        JSON.stringify({ savedAt: new Date().toISOString(), iniSource: iniSrc }, null, 2),
        'utf-8'
    );

    return saved;
}

// Epic rotates the RememberMe token on every launcher start, so a backup goes
// stale the moment its account is used. Like TcNo, re-save the CURRENT account's
// live session into its slot before overwriting the live files with the target's.
// Must be called AFTER killing Epic and BEFORE restoring the target session.
async function resaveCurrentSessionBeforeSwitch(platform, info, targetAccountName) {
    try {
        const platDir = path.join(SESSIONS_DIR, platform);
        if (!fs.existsSync(platDir)) return;

        let currentName = null;

        if (platform === 'epic') {
            // Most reliable: match live registry AccountId against each slot's saved id
            const liveId = await readRegistryString(
                EPIC_REGISTRY.hive,
                EPIC_REGISTRY.key,
                EPIC_REGISTRY.valueName
            );
            if (liveId) {
                for (const name of fs.readdirSync(platDir)) {
                    if (name === targetAccountName) continue;
                    const slotDir = path.join(platDir, name);
                    if (!fs.statSync(slotDir).isDirectory()) continue;
                    let slotId = null;
                    try {
                        slotId = JSON.parse(
                            fs.readFileSync(path.join(slotDir, 'registry', 'AccountId.json'), 'utf-8')
                        ).value;
                    } catch (e) {}
                    if (!slotId) slotId = deriveEpicAccountIdFromBackup(slotDir);
                    if (slotId && slotId.toLowerCase() === liveId.toLowerCase()) {
                        currentName = name;
                        break;
                    }
                }
            }
        }

        // Fallback: last known active account from state
        if (!currentName) {
            const state = readPlatformActiveState();
            if (state[platform] && state[platform] !== targetAccountName) {
                const dir = path.join(platDir, state[platform]);
                if (fs.existsSync(dir)) currentName = state[platform];
            }
        }

        if (!currentName) return;

        sendSessionProgress(platform, 'resaving-current');
        const saved = await saveSessionFromPlatform(info, path.join(platDir, currentName), platform);
        console.log(`[session] re-saved live ${platform} session into "${currentName}" (${saved} slots)`);
    } catch (e) {
        console.error('[session] resave-before-switch failed:', e.message);
    }
}

async function restoreSessionToPlatform(info, sourceDir, platform = '') {
    const roots = getSessionRoots(info);
    let restored = 0;

    const savedRoot = roots.find(r => r.slot === 'Saved');
    if (savedRoot && fs.existsSync(path.join(sourceDir, 'Config')) && !fs.existsSync(path.join(sourceDir, 'Saved'))) {
        try {
            sendSessionProgress(platform, 'restoring-legacy');
            await removePathSafe(savedRoot.path);
            await copyTreeAsync(sourceDir, savedRoot.path);
            restored++;
        } catch (e) {
            console.error('[session] legacy epic restore failed:', e.message);
        }
    }

    for (const root of roots) {
        const sourceSlot = path.join(sourceDir, root.slot);
        if (!fs.existsSync(sourceSlot)) continue;
        try {
            sendSessionProgress(platform, `restoring-${root.slot}`);
            await removePathSafe(root.path);
            await copyTreeAsync(sourceSlot, root.path);
            restored++;
            await new Promise(r => setImmediate(r));
        } catch (e) {
            console.error(`[session] restore failed ${root.slot}:`, e.message);
        }
    }
    return restored;
}

async function saveSessionFromPlatform(info, targetDir, platform = '') {
    if (platform === 'epic' && info.useTcNoStyle) {
        return saveEpicSessionTcNo(targetDir, platform);
    }

    const roots = getSessionRoots(info);
    let saved = 0;
    for (const root of roots) {
        if (!fs.existsSync(root.path)) continue;
        const destSlot = path.join(targetDir, root.slot);
        try {
            sendSessionProgress(platform, `saving-${root.slot}`);
            await removePathSafe(destSlot);
            await fsp.mkdir(destSlot, { recursive: true });
            await copyTreeAsync(root.path, destSlot);
            saved++;
            await new Promise(r => setImmediate(r));
        } catch (e) {
            console.error(`[session] save failed ${root.slot}:`, e.message);
        }
    }
    return saved;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    autoHideMenuBar: true
  });

  mainWindow.loadFile('index.html');

  // Prevent app from closing, minimize to tray instead
  mainWindow.on('close', function (event) {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });
}

function buildTrayMenu() {
  const labels = TRAY_LABELS[trayLang] || TRAY_LABELS.ar;
  return Menu.buildFromTemplate([
    { label: labels.open, click: () => { if (mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    {
      label: labels.quit,
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  let trayIcon = null;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) trayIcon = null;
  }
  if (!trayIcon) {
    // 16x16 cyan square — avoids empty tray crash on Windows
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVQ4T2NkYGD4z0ABYBw1gGE0DBhGwwAGBgZGDAwMDP8ZGBgYGP4zMDAwMAAAAP//AwBqFQABfL0X8AAAAABJRU5ErkJggg==';
    trayIcon = nativeImage.createFromDataURL(dataUrl);
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Nexus Switcher');
  tray.setContextMenu(buildTrayMenu());

  tray.on('click', () => {
    if (mainWindow) mainWindow.show();
  });
}

function updateTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

app.whenReady().then(() => {
  // Clean up autostart settings if running in development mode
  // to prevent the terminal window starting on Windows boot.
  if (!app.isPackaged) {
    try {
      app.setLoginItemSettings({
        openAtLogin: false,
        path: process.execPath,
        args: [path.resolve(__dirname)]
      });
    } catch (e) {
      console.error('Failed to clean up development autostart settings:', e);
    }
  }

  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});

ipcMain.handle('set-tray-lang', (event, lang) => {
  if (lang === 'en' || lang === 'ar') {
    trayLang = lang;
    updateTrayMenu();
  }
});

// IPC handler to get Steam path from registry
ipcMain.handle('get-steam-path', () => {
  return new Promise((resolve, reject) => {
    exec('reg query HKCU\\Software\\Valve\\Steam /v SteamPath', (error, stdout, stderr) => {
      if (error) {
        console.error('Error reading registry:', error);
        return resolve(null);
      }
      
      // Parse output: "    SteamPath    REG_SZ    c:/program files (x86)/steam"
      const match = stdout.match(/REG_SZ\s+(.+)/);
      if (match && match[1]) {
        resolve(match[1].trim());
      } else {
        resolve(null);
      }
    });
  });
});

ipcMain.handle('set-autostart', (event, enable) => {
    try {
        if (!app.isPackaged) {
            // Do not allow setting autostart in development mode.
            // Clean up any existing autostart entry for this path.
            app.setLoginItemSettings({
                openAtLogin: false,
                path: process.execPath,
                args: [path.resolve(__dirname)]
            });
            return false;
        }

        const settings = {
            openAtLogin: enable,
            path: process.execPath
        };
        app.setLoginItemSettings(settings);
        // Verify it was set correctly
        const result = app.getLoginItemSettings();
        return result.openAtLogin;
    } catch(e) {
        console.error('Autostart error:', e);
        return !enable; // Return opposite = failed
    }
});

ipcMain.handle('get-autostart', () => {
    try {
        if (!app.isPackaged) {
            return false;
        }
        const settings = app.getLoginItemSettings();
        return settings.openAtLogin;
    } catch(e) {
        return false;
    }
});

// ===== Encryption (safeStorage - OS-bound, no password needed) =====
ipcMain.handle('encrypt-data', (event, plaintext) => {
    try {
        if (!safeStorage.isEncryptionAvailable()) return { success: false, data: plaintext };
        const encrypted = safeStorage.encryptString(plaintext);
        return { success: true, data: encrypted.toString('base64') };
    } catch(e) {
        return { success: false, error: e.message, data: plaintext };
    }
});

ipcMain.handle('decrypt-data', (event, base64data) => {
    try {
        if (!safeStorage.isEncryptionAvailable()) return { success: false, data: base64data };
        const buffer = Buffer.from(base64data, 'base64');
        const decrypted = safeStorage.decryptString(buffer);
        return { success: true, data: decrypted };
    } catch(e) {
        return { success: false, error: e.message, data: null };
    }
});

ipcMain.handle('encryption-available', () => safeStorage.isEncryptionAvailable());

async function killPlatformProcesses(platform) {
    const info = PLATFORM_INFO[platform];
    const list = (info && info.kill) ? info.kill : (info && info.process ? [info.process] : []);
    for (const proc of list) {
        await new Promise(r => exec(`taskkill /F /IM ${proc} /T`, () => r()));
    }
    const delay = (info && info.killDelayMs) ? info.killDelayMs : 1500;
    await new Promise(r => setTimeout(r, delay));
}

ipcMain.handle('save-platform-session', async (event, platform, accountName) => {
    try {
        const info = PLATFORM_INFO[platform];
        if (!info) throw new Error('Unknown platform.');

        await killPlatformProcesses(platform);

        const targetDir = sessionSlotDir(platform, accountName);
        const createdDir = !fs.existsSync(targetDir);
        if (createdDir) fs.mkdirSync(targetDir, { recursive: true });

        const savedCount = await saveSessionFromPlatform(info, targetDir, platform);
        if (savedCount === 0) {
            if (createdDir) {
                try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (e) {}
            }
            throw new Error('Platform data not found. Open the launcher, log in, then save the session again.');
        }

        return { success: true, savedSlots: savedCount };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('switch-platform-session', async (event, platform, accountName) => {
    try {
        const sourceDir = sessionSlotDir(platform, accountName);
        const info = PLATFORM_INFO[platform];

        if (!fs.existsSync(sourceDir)) throw new Error('Session not found.');

        await killPlatformProcesses(platform);

        // Keep the current account's slot fresh (Epic rotates tokens every launch)
        await resaveCurrentSessionBeforeSwitch(platform, info, accountName);

        let restored = 0;
        if (platform === 'epic' && info.useTcNoStyle) {
            restored = await restoreEpicUnified(sourceDir, platform);
        } else {
            restored = await restoreSessionToPlatform(info, sourceDir, platform);
        }
        if (restored === 0) {
            throw new Error('Session backup is empty or corrupted. Save the session again.');
        }

        const state = readPlatformActiveState();
        state[platform] = accountName;
        writePlatformActiveState(state);

        const launchDelay = info.launchDelayMs || 800;
        await new Promise(r => setTimeout(r, launchDelay));
        launchPlatformAppMain(platform);

        return { success: true, restored, launched: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('launch-platform', (event, platform) => {
    if (PLATFORM_INFO[platform]) {
        launchPlatformAppMain(platform);
        return { success: true };
    }
    return { success: false };
});

// Prepare any launcher for adding a NEW account without a server-side sign-out.
// Signing out via the launcher's own UI can revoke the saved login token, which
// invalidates existing backups. Instead we close the launcher, clear ONLY the
// local session, and reopen it on the login screen — the account stays valid on
// the launcher's servers, so its backup can still be restored with auto-login.
async function epicPrepareNewAccount(info, platform) {
    // Best-effort: preserve the currently signed-in account by re-saving its live
    // session into the matching slot (identified reliably via live registry id).
    let backedUp = null;
    try {
        const platDir = path.join(SESSIONS_DIR, platform);
        const liveId = await readRegistryString(
            EPIC_REGISTRY.hive, EPIC_REGISTRY.key, EPIC_REGISTRY.valueName
        );
        if (liveId && fs.existsSync(platDir)) {
            for (const name of fs.readdirSync(platDir)) {
                const slotDir = path.join(platDir, name);
                try { if (!fs.statSync(slotDir).isDirectory()) continue; } catch (e) { continue; }
                let slotId = null;
                try {
                    slotId = JSON.parse(
                        fs.readFileSync(path.join(slotDir, 'registry', 'AccountId.json'), 'utf-8')
                    ).value;
                } catch (e) {}
                if (!slotId) slotId = deriveEpicAccountIdFromBackup(slotDir);
                if (slotId && slotId.toLowerCase() === liveId.toLowerCase()) {
                    await saveSessionFromPlatform(info, slotDir, platform);
                    backedUp = name;
                    break;
                }
            }
        }
    } catch (e) {
        console.error('[epic] pre-clear backup failed:', e.message);
    }

    // Clear ONLY the local session (no server-side sign-out) so Epic shows login
    for (const ini of EPIC_GAME_USER_SETTINGS) {
        try { await removePathSafe(ini); } catch (e) {}
    }
    try {
        await execAsync(
            `reg delete "${EPIC_REGISTRY.hive}\\${EPIC_REGISTRY.key}" /v "${EPIC_REGISTRY.valueName}" /f`
        );
    } catch (e) {}
    await clearEpicWebCaches();
    await clearEpicCaches();

    return { success: true, backedUp };
}

ipcMain.handle('platform-prepare-new-account', async (event, platform) => {
    try {
        const info = PLATFORM_INFO[platform];
        if (!info) throw new Error('Unknown platform.');

        // Close the launcher so its session files aren't locked
        await killPlatformProcesses(platform);

        let result;
        if (platform === 'epic' && info.useTcNoStyle) {
            result = await epicPrepareNewAccount(info, platform);
        } else {
            // Generic launchers: the whole session-root folder(s) hold the login, so
            // clearing them makes the launcher reopen on its login screen. There is no
            // token-revocation concept here, so previously-saved backups stay valid.
            // (The UI asks the user to save the current account first to keep it.)
            let cleared = 0;
            for (const root of getSessionRoots(info)) {
                try {
                    if (fs.existsSync(root.path)) { await removePathSafe(root.path); cleared++; }
                } catch (e) {
                    console.error(`[${platform}] clear failed ${root.slot}:`, e.message);
                }
            }
            // No account is signed in locally now
            const state = readPlatformActiveState();
            if (state[platform]) { delete state[platform]; writePlatformActiveState(state); }
            result = { success: true, cleared };
        }

        // Reopen the launcher → now on the login screen for the new account
        launchPlatformAppMain(platform);
        return result;
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('is-platform-running', async (event, platform) => {
    const info = PLATFORM_INFO[platform];
    if (!info) return false;
    return new Promise((resolve) => {
        exec(`tasklist /FI "IMAGENAME eq ${info.process}" /NH`, (err, stdout) => {
            resolve(!err && stdout.toLowerCase().includes(info.process.toLowerCase()));
        });
    });
});

ipcMain.handle('get-platform-active-state', () => readPlatformActiveState());

ipcMain.handle('set-platform-active-state', (event, platform, accountName) => {
    const state = readPlatformActiveState();
    if (accountName) state[platform] = accountName;
    else delete state[platform];
    writePlatformActiveState(state);
    return state;
});

ipcMain.handle('get-platform-sessions', () => {
    const sessions = {};
    for (const plat of Object.keys(PLATFORM_INFO)) {
        sessions[plat] = [];
        const pDir = path.join(SESSIONS_DIR, plat);
        if (fs.existsSync(pDir)) {
            sessions[plat] = fs.readdirSync(pDir, { withFileTypes: true })
                               .filter(dirent => dirent.isDirectory())
                               .map(dirent => dirent.name);
        }
    }
    return sessions;
});

ipcMain.handle('delete-platform-session', async (event, platform, accountName) => {
    try {
        const sourceDir = sessionSlotDir(platform, accountName);
        if (fs.existsSync(sourceDir)) {
            fs.rmSync(sourceDir, { recursive: true, force: true });
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('rename-platform-session', async (event, platform, oldName, newName) => {
    try {
        const oldDir = sessionSlotDir(platform, oldName);
        const newDir = sessionSlotDir(platform, newName);
        if (path.resolve(oldDir) === path.resolve(newDir)) return { success: true };
        if (fs.existsSync(newDir)) throw new Error('This name already exists.');
        if (fs.existsSync(oldDir)) fs.renameSync(oldDir, newDir);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ===== System Performance Monitor =====
let lastCpuInfo = os.cpus();

function getCpuUsage() {
    const cpus = os.cpus();
    let totalIdle = 0, totalTick = 0;
    for (let i = 0; i < cpus.length; i++) {
        const cpu = cpus[i];
        const lastCpu = lastCpuInfo[i];
        const tickDiff = Object.values(cpu.times).reduce((a, b) => a + b, 0) -
                         Object.values(lastCpu.times).reduce((a, b) => a + b, 0);
        const idleDiff = cpu.times.idle - lastCpu.times.idle;
        totalTick += tickDiff;
        totalIdle += idleDiff;
    }
    lastCpuInfo = cpus;
    if (totalTick === 0) return 0;
    return Math.max(0, Math.min(100, Math.round(100 - (100 * totalIdle / totalTick))));
}

ipcMain.handle('get-system-stats', async () => {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    return {
        cpu: {
            usage: getCpuUsage(),
            cores: os.cpus().length,
            model: os.cpus()[0].model
        },
        ram: {
            total: totalMem,
            used: usedMem,
            free: freeMem,
            usagePercent: Math.round((usedMem / totalMem) * 100),
            totalGB: (totalMem / 1073741824).toFixed(1),
            usedGB: (usedMem / 1073741824).toFixed(1)
        },
        uptime: os.uptime(),
        platform: os.platform(),
        hostname: os.hostname()
    };
});

ipcMain.handle('get-gpu-stats', () => {
    return new Promise((resolve) => {
        // Try nvidia-smi first
        exec('nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits', (err, stdout) => {
            if (!err && stdout.trim()) {
                const parts = stdout.trim().split(',').map(s => s.trim());
                return resolve({
                    available: true,
                    name: parts[0],
                    usage: parseInt(parts[1]) || 0,
                    memUsed: parseInt(parts[2]) || 0,
                    memTotal: parseInt(parts[3]) || 0,
                    temp: parseInt(parts[4]) || 0,
                    type: 'nvidia'
                });
            }
            // Fallback: try Windows Performance Counter for GPU
            exec('powershell -Command "(Get-Counter \'\\GPU Engine(*engtype_3D)\\Utilization Percentage\' -ErrorAction SilentlyContinue).CounterSamples | Where-Object {$_.CookedValue -gt 0} | Measure-Object -Property CookedValue -Sum | Select-Object -ExpandProperty Sum"', (err2, stdout2) => {
                const usage = parseFloat(stdout2);
                if (!isNaN(usage)) {
                    return resolve({ available: true, name: 'GPU', usage: Math.min(100, Math.round(usage)), type: 'generic' });
                }
                resolve({ available: false });
            });
        });
    });
});

// ===== Update Checker (checks GitHub releases) =====
ipcMain.handle('check-updates', () => {
    return new Promise((resolve) => {
        const currentVersion = app.getVersion();
        // Use a public endpoint - user can configure their own GitHub repo
        const options = {
            hostname: 'api.github.com',
            path: '/repos/kd9s/nexus-switcher/releases/latest',
            headers: { 'User-Agent': 'NexusSwitcher' },
            timeout: 5000
        };
        
        // Read repo from package.json if available
        try {
            const pkg = require('./package.json');
            if (pkg.repository && pkg.repository.url) {
                const match = pkg.repository.url.match(/github\.com[:/]([\w-]+)\/([\w-]+)/);
                if (match) {
                    options.path = `/repos/${match[1]}/${match[2].replace('.git','')}/releases/latest`;
                }
            }
        } catch(e) {}
        
        const req = https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const release = JSON.parse(data);
                    const latestVersion = (release.tag_name || '').replace(/^v/, '');
                    if (!latestVersion) return resolve({ success: false, error: 'no_release', current: currentVersion });
                    const isNewer = compareVersions(latestVersion, currentVersion) > 0;
                    resolve({
                        success: true,
                        current: currentVersion,
                        latest: latestVersion,
                        hasUpdate: isNewer,
                        url: release.html_url,
                        notes: release.body || ''
                    });
                } catch(e) {
                    resolve({ success: false, error: 'parse_error', current: currentVersion });
                }
            });
        });
        req.on('error', () => resolve({ success: false, error: 'network', current: currentVersion }));
        req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'timeout', current: currentVersion }); });
    });
});

function compareVersions(a, b) {
    const pa = a.split('.').map(n => parseInt(n) || 0);
    const pb = b.split('.').map(n => parseInt(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

ipcMain.handle('open-external', (event, url) => {
    shell.openExternal(url);
});

ipcMain.handle('app-version', () => app.getVersion());

// ===== Backup / Import / Export =====
ipcMain.handle('export-backup', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'حفظ النسخة الاحتياطية',
        defaultPath: `nexus-backup-${new Date().toISOString().split('T')[0]}.json`,
        filters: [{ name: 'JSON Backup', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    return { success: true, filePath: result.filePath };
});

ipcMain.handle('import-backup', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'اختر ملف النسخة الاحتياطية',
        filters: [{ name: 'JSON Backup', extensions: ['json'] }],
        properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true };
    return { success: true, filePath: result.filePaths[0] };
});

// ===== Process Monitor for Playtime Tracking =====
ipcMain.handle('is-process-running', (event, processName) => {
    return new Promise((resolve) => {
        exec(`tasklist /FI "IMAGENAME eq ${processName}" /NH`, (err, stdout) => {
            resolve(!err && stdout.toLowerCase().includes(processName.toLowerCase()));
        });
    });
});

ipcMain.handle('list-running-games', () => {
    return new Promise((resolve) => {
        // Get all processes and filter likely game executables
        exec('tasklist /FO CSV /NH', (err, stdout) => {
            if (err) return resolve([]);
            const lines = stdout.split('\n').map(l => {
                const m = l.match(/^"([^"]+)"/);
                return m ? m[1].toLowerCase() : null;
            }).filter(Boolean);
            resolve(lines);
        });
    });
});

ipcMain.handle('user-data-path', () => app.getPath('userData'));

// ===== Steam Server Status (direct HTTP probes - more reliable) =====
function probeService(hostname, path = '/', timeoutMs = 5000) {
    return new Promise((resolve) => {
        const start = Date.now();
        const req = https.request({
            hostname,
            path,
            method: 'HEAD',
            timeout: timeoutMs,
            headers: { 'User-Agent': 'NexusSwitcher/1.0' }
        }, (res) => {
            const latency = Date.now() - start;
            const status = res.statusCode;
            // Determine status: 2xx/3xx = normal, 5xx = major, others = minor
            let label;
            if (status >= 200 && status < 400) label = latency > 2000 ? 'minor' : 'normal';
            else if (status >= 500) label = 'major';
            else label = 'minor';
            resolve({ status: label, latency, httpCode: status });
            res.resume();
        });
        req.on('error', () => resolve({ status: 'offline', latency: Date.now() - start }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 'offline', latency: timeoutMs }); });
        req.end();
    });
}

ipcMain.handle('get-steam-status', async () => {
    try {
        // Probe key Steam services in parallel
        const services = {
            'Steam Store': await probeService('store.steampowered.com'),
            'Community': await probeService('steamcommunity.com'),
            'Web API': await probeService('api.steampowered.com', '/ISteamWebAPIUtil/GetServerInfo/v1/'),
            'CDN (Akamai)': await probeService('cdn.akamai.steamstatic.com'),
            'CDN (Cloudflare)': await probeService('cdn.cloudflare.steamstatic.com'),
            'Help Site': await probeService('help.steampowered.com'),
            'Partner Network': await probeService('partner.steamgames.com')
        };
        
        const result = {};
        for (const name in services) {
            const s = services[name];
            const title = s.status === 'normal' ? `${s.latency}ms` : 
                         s.status === 'minor' ? `Slow (${s.latency}ms)` :
                         s.status === 'offline' ? 'Offline' : 'Issues';
            result[name] = { status: s.status, title, latency: s.latency };
        }
        
        return { success: true, services: result };
    } catch(e) {
        return { success: false, error: e.message };
    }
});

// ===== VRAM Optimizer =====
function getFolderSizeSync(dir) {
    let total = 0;
    try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const it of items) {
            const p = path.join(dir, it.name);
            try {
                if (it.isDirectory()) {
                    total += getFolderSizeSync(p);
                } else {
                    total += fs.statSync(p).size;
                }
            } catch (e) {}
        }
    } catch (e) {}
    return total;
}

function deleteFolderContents(dir) {
    let deleted = 0;
    try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const it of items) {
            const p = path.join(dir, it.name);
            try {
                if (it.isDirectory()) {
                    fs.rmSync(p, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(p);
                }
                deleted++;
            } catch (e) {
                // File in use, skip
            }
        }
    } catch (e) {}
    return deleted;
}

ipcMain.handle('clear-shader-cache', async () => {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    
    // Candidate cache paths
    const cachePaths = [
        path.join(localAppData, 'NVIDIA', 'DXCache'),
        path.join(localAppData, 'NVIDIA', 'GLCache'),
        path.join(localAppData, 'NVIDIA', 'ComputeCache'),
        path.join(localAppData, 'NVIDIA', 'OptixCache'),
        path.join(localAppData, 'NVIDIA Corporation', 'NV_Cache'),
        path.join(localAppData, 'AMD', 'DxCache'),
        path.join(localAppData, 'AMD', 'GLCache'),
        path.join(localAppData, 'AMD', 'DxcCache'),
        path.join(localAppData, 'D3DSCache'),
        path.join(localAppData, 'Microsoft', 'DirectX Shader Cache')
    ];
    
    // Try to add Steam shader caches
    try {
        const steamPath = await new Promise((resolve) => {
            exec('reg query HKCU\\Software\\Valve\\Steam /v SteamPath', (err, stdout) => {
                if (err) return resolve(null);
                const m = stdout.match(/REG_SZ\s+(.+)/);
                resolve(m ? m[1].trim() : null);
            });
        });
        if (steamPath) {
            cachePaths.push(path.join(steamPath, 'appcache', 'shadercache'));
            cachePaths.push(path.join(steamPath, 'steamapps', 'shadercache'));
        }
    } catch (e) {}
    
    let totalFreedBytes = 0;
    let cleanedCount = 0;
    const cleanedPaths = [];
    
    for (const p of cachePaths) {
        if (fs.existsSync(p)) {
            const sizeBefore = getFolderSizeSync(p);
            if (sizeBefore > 0) {
                deleteFolderContents(p);
                const sizeAfter = getFolderSizeSync(p);
                const freed = sizeBefore - sizeAfter;
                if (freed > 0) {
                    totalFreedBytes += freed;
                    cleanedCount++;
                    cleanedPaths.push({ path: p, freed });
                }
            }
        }
    }
    
    return {
        success: true,
        freedBytes: totalFreedBytes,
        freedMB: (totalFreedBytes / (1024 * 1024)).toFixed(1),
        cleanedCount,
        paths: cleanedPaths
    };
});

ipcMain.handle('restart-gpu-driver', async () => {
    // Simulate Win + Ctrl + Shift + B (built-in Windows GPU driver reset hotkey)
    return new Promise((resolve) => {
        const psCommand = `
$sig = @'
[DllImport("user32.dll")]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
'@
$kb = Add-Type -MemberDefinition $sig -Name KB -Namespace Win -PassThru
$kb::keybd_event(0x5B, 0, 0, 0)
$kb::keybd_event(0x11, 0, 0, 0)
$kb::keybd_event(0x10, 0, 0, 0)
$kb::keybd_event(0x42, 0, 0, 0)
Start-Sleep -Milliseconds 80
$kb::keybd_event(0x42, 0, 2, 0)
$kb::keybd_event(0x10, 0, 2, 0)
$kb::keybd_event(0x11, 0, 2, 0)
$kb::keybd_event(0x5B, 0, 2, 0)
`.trim();
        
        // Write to temp file and execute
        const tmpFile = path.join(os.tmpdir(), `nexus-gpu-reset-${Date.now()}.ps1`);
        try {
            fs.writeFileSync(tmpFile, psCommand);
            exec(`powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "${tmpFile}"`, (err) => {
                try { fs.unlinkSync(tmpFile); } catch (e) {}
                if (err) {
                    resolve({ success: false, error: err.message });
                } else {
                    resolve({ success: true });
                }
            });
        } catch (e) {
            resolve({ success: false, error: e.message });
        }
    });
});
