const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const vdf = require('vdf-parser');
const { exec } = require('child_process');
const os = require('os');

let steamPath = '';
let loginUsers = {};
let steamAccountsCatalog = {};
let steamCatalogFile = '';
let platformAccountsCatalog = {};
let platformCatalogFile = '';
let isSwitchingAccount = false;
let isSwitchingPlatform = false;

const PLATFORM_META = {
    epic: { name: 'Epic Games', icon: 'fa-solid fa-e', color: '#313131', launch: () => ipcRenderer.invoke('launch-platform', 'epic') },
    riot: { name: 'Riot Games', icon: 'fa-solid fa-r', color: '#eb0029', launch: () => {
        const riotPath = 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe';
        if (fs.existsSync(riotPath)) exec(`start "" "${riotPath}"`);
        else exec('start riotclient://');
    }},
    ea: { name: 'EA App', icon: 'fa-solid fa-gamepad', color: '#ff4747', launch: () => {
        const eaPath = 'C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe';
        if (fs.existsSync(eaPath)) exec(`start "" "${eaPath}"`);
        else exec('start origin2://');
    }},
    ubisoft: { name: 'Ubisoft Connect', icon: 'fa-solid fa-u', color: '#0070ff', launch: () => exec('start uplay://') },
    battlenet: { name: 'Battle.net', icon: 'fa-brands fa-battle-net', color: '#00a4e4', launch: () => exec('start battlenet://') }
};
let customCovers = {};
let coversFile = '';
let gameAccountsFile = '';
let accountNotesFile = '';
let playtimeFile = '';

// Manual game -> accountName mapping (highest priority for auto-switch)
let gameAccounts = {};
// Account notes: steamId -> note text
let accountNotes = {};
// Playtime tracking: gameId -> { totalSeconds, lastPlayed, sessions }
let playtimeData = {};
// Account stats: steamId -> { gameCount, walletBalance }
let accountStats = {};

// ===== Encrypted file I/O =====
const ENCRYPTED_PREFIX = 'NEXUS_ENC:';

async function readEncryptedJson(filePath, fallback = {}) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (!content) return fallback;
        if (content.startsWith(ENCRYPTED_PREFIX)) {
            const result = await ipcRenderer.invoke('decrypt-data', content.substring(ENCRYPTED_PREFIX.length));
            if (result.success && result.data) return JSON.parse(result.data);
            return fallback;
        }
        return JSON.parse(content);
    } catch(e) { console.error('readEncryptedJson:', filePath, e); return fallback; }
}

async function writeEncryptedJson(filePath, data) {
    try {
        const json = JSON.stringify(data, null, 2);
        const useEncryption = localStorage.getItem('nexus_encryption') === 'true';
        if (useEncryption) {
            const result = await ipcRenderer.invoke('encrypt-data', json);
            if (result.success) {
                fs.writeFileSync(filePath, ENCRYPTED_PREFIX + result.data, 'utf-8');
                return;
            }
        }
        fs.writeFileSync(filePath, json, 'utf-8');
    } catch(e) { console.error('writeEncryptedJson:', filePath, e); }
}

// ===== i18n System =====
let currentLang = localStorage.getItem('nexus_lang') || 'ar';
let translations = {};

function loadTranslations() {
    try {
        const langFile = path.join(__dirname, 'i18n', `${currentLang}.json`);
        translations = JSON.parse(fs.readFileSync(langFile, 'utf-8'));
    } catch(e) {
        console.error('Failed to load translations:', e);
        translations = {};
    }
}

function t(key, fallback) {
    const parts = key.split('.');
    let val = translations;
    for (const p of parts) {
        if (val && typeof val === 'object' && p in val) val = val[p];
        else return fallback || key;
    }
    return typeof val === 'string' ? val : (fallback || key);
}

function setLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('nexus_lang', lang);
    loadTranslations();
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    applyTranslations();
    ipcRenderer.invoke('set-tray-lang', lang).catch(() => {});
}

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        // Handle input placeholders
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            if (!el.hasAttribute('data-i18n-placeholder')) {
                el.innerText = t(key); // some cases
            }
        } else {
            el.innerText = t(key);
        }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        el.placeholder = t(key);
    });
    
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.title = t(el.getAttribute('data-i18n-title'));
    });

    document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
        el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
    });

}

loadTranslations();

async function initDataStorage() {
    const userData = await ipcRenderer.invoke('user-data-path');
    const dataDir = path.join(userData, 'nexus-data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    coversFile = path.join(dataDir, 'customCovers.json');
    gameAccountsFile = path.join(dataDir, 'gameAccounts.json');
    accountNotesFile = path.join(dataDir, 'accountNotes.json');
    playtimeFile = path.join(dataDir, 'playtime.json');
    steamCatalogFile = path.join(dataDir, 'steam-accounts-catalog.json');
    platformCatalogFile = path.join(dataDir, 'platform-accounts-catalog.json');

    const legacyFiles = [
        ['customCovers.json', coversFile],
        ['gameAccounts.json', gameAccountsFile],
        ['accountNotes.json', accountNotesFile],
        ['playtime.json', playtimeFile]
    ];
    for (const [name, dest] of legacyFiles) {
        const legacy = path.join(__dirname, name);
        if (!fs.existsSync(legacy)) continue;
        try {
            const legacySize = fs.statSync(legacy).size;
            const destSize = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
            if (legacySize > 0 && destSize < legacySize) {
                fs.copyFileSync(legacy, dest);
            }
        } catch (e) {}
    }

    customCovers = await readEncryptedJson(coversFile, {});
    gameAccounts = await readEncryptedJson(gameAccountsFile, {});
    accountNotes = await readEncryptedJson(accountNotesFile, {});
    playtimeData = await readEncryptedJson(playtimeFile, {});
    steamAccountsCatalog = await readEncryptedJson(steamCatalogFile, {});
    platformAccountsCatalog = await readEncryptedJson(platformCatalogFile, {});
}

const appInitPromise = initDataStorage();

function saveGameAccounts() {
    if (gameAccountsFile) writeEncryptedJson(gameAccountsFile, gameAccounts);
}

function saveAccountNotes() {
    if (accountNotesFile) writeEncryptedJson(accountNotesFile, accountNotes);
}

function savePlaytime() {
    if (playtimeFile) writeEncryptedJson(playtimeFile, playtimeData);
}

function saveCustomCovers() {
    if (coversFile) writeEncryptedJson(coversFile, customCovers);
}

// ===== Playtime Tracking =====
const activeGameSessions = {}; // gameId -> { startTime, exeName, processCheckInterval }

function startGameSession(gameId, gameName, exeName) {
    if (activeGameSessions[gameId]) return; // already tracking
    
    const session = {
        startTime: Date.now(),
        gameName,
        exeName: exeName ? path.basename(exeName).toLowerCase() : null,
        processCheckInterval: null
    };
    activeGameSessions[gameId] = session;
    
    // For Steam games, monitor steam process and check if game window exists
    // Simpler approach: check if exe is running every 30 seconds
    if (session.exeName) {
        session.processCheckInterval = setInterval(async () => {
            const isRunning = await ipcRenderer.invoke('is-process-running', session.exeName);
            if (!isRunning) {
                endGameSession(gameId);
            }
        }, 30000);
    } else {
        // No exe known - just track for max 4 hours then auto-end
        session.processCheckInterval = setTimeout(() => endGameSession(gameId), 4 * 60 * 60 * 1000);
    }
}

function endGameSession(gameId) {
    const session = activeGameSessions[gameId];
    if (!session) return;
    
    if (session.processCheckInterval) {
        clearInterval(session.processCheckInterval);
        clearTimeout(session.processCheckInterval);
    }
    
    const duration = Math.round((Date.now() - session.startTime) / 1000);
    if (duration < 30) { // ignore sessions less than 30 sec (false starts)
        delete activeGameSessions[gameId];
        return;
    }
    
    if (!playtimeData[gameId]) {
        playtimeData[gameId] = { totalSeconds: 0, lastPlayed: 0, sessions: 0, name: session.gameName };
    }
    playtimeData[gameId].totalSeconds += duration;
    playtimeData[gameId].lastPlayed = Date.now();
    playtimeData[gameId].sessions = (playtimeData[gameId].sessions || 0) + 1;
    playtimeData[gameId].name = session.gameName;
    savePlaytime();
    
    delete activeGameSessions[gameId];
}

function formatPlaytime(seconds) {
    if (!seconds || seconds < 60) return null;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}${t('game.hours')} ${mins}${t('game.minutes')}`;
    return `${mins}${t('game.minutes')}`;
}

function formatLastPlayed(timestamp) {
    if (!timestamp) return null;
    const days = Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24));
    if (days === 0) return t('common.today');
    if (days === 1) return t('common.yesterday');
    if (days < 7) return t('common.days_ago', `${days} days`).replace('{n}', String(days));
    if (days < 30) {
        const w = Math.floor(days / 7);
        return t('common.weeks_ago', `${w} weeks`).replace('{n}', String(w));
    }
    const m = Math.floor(days / 30);
    return t('common.months_ago', `${m} months`).replace('{n}', String(m));
}

// Cleanup sessions on window close
window.addEventListener('beforeunload', () => {
    for (const gameId in activeGameSessions) endGameSession(gameId);
});

// Get the ACTUAL currently logged-in Steam account from registry (more reliable than MostRecent flag)
function getCurrentSteamAccount() {
    return new Promise((resolve) => {
        exec('reg query "HKCU\\Software\\Valve\\Steam" /v AutoLoginUser', (err, stdout) => {
            if (err) return resolve(null);
            const match = stdout.match(/AutoLoginUser\s+REG_SZ\s+(.+)/);
            resolve(match ? match[1].trim() : null);
        });
    });
}

function findAccountNameInUsers(users, accountName) {
    if (!accountName) return null;
    for (const steamId of Object.keys(users)) {
        const name = users[steamId].AccountName;
        if (name && name.toLowerCase() === accountName.toLowerCase()) return name;
    }
    return null;
}

async function getActiveSteamSession(users) {
    const steamRunning = await ipcRenderer.invoke('is-process-running', 'steam.exe');
    if (!steamRunning) {
        return { active: false, accountName: null, steamRunning: false, personaName: null };
    }

    let accountName = await getCurrentSteamAccount();
    accountName = findAccountNameInUsers(users, accountName);

    if (!accountName) {
        for (const steamId of Object.keys(users)) {
            if (users[steamId].MostRecent === '1') {
                accountName = users[steamId].AccountName;
                break;
            }
        }
    }

    let personaName = null;
    if (accountName) {
        for (const steamId of Object.keys(users)) {
            if (users[steamId].AccountName === accountName) {
                personaName = users[steamId].PersonaName || accountName;
                break;
            }
        }
    }

    return {
        active: !!accountName,
        accountName,
        personaName,
        steamRunning: true
    };
}

// Auto-detected ownership map: appId -> accountName
let gameOwnershipMap = {};
let _ownershipMapCacheKey = '';

// Build a complete game ownership map + account stats by scanning userdata + localconfig
function buildGameOwnershipMap() {
    // This scan is expensive (steam/userdata can be huge). Only rebuild when inputs change.
    const idsKey = Object.keys(loginUsers || {}).sort().join(',');
    const cacheKey = `${steamPath || ''}|${idsKey}`;
    if (cacheKey === _ownershipMapCacheKey) {
        return;
    }

    gameOwnershipMap = {};
    accountStats = {};
    if (!steamPath || Object.keys(loginUsers).length === 0) return;
    
    const userdataDir = path.join(steamPath, 'userdata');
    if (!fs.existsSync(userdataDir)) return;
    
    let userFolders;
    try { userFolders = fs.readdirSync(userdataDir); } catch(e) { return; }
    
    for (const folder of userFolders) {
        const accountId32 = folder;
        if (isNaN(accountId32) || accountId32 === '0') continue;
        
        const steamId64 = (BigInt(accountId32) + BigInt("76561197960265728")).toString();
        if (!loginUsers[steamId64]) continue;
        const accountName = loginUsers[steamId64].AccountName;
        
        // Initialize stats for this account
        accountStats[steamId64] = { gameCount: 0, walletBalance: null, walletCurrency: null, gameIds: new Set() };
        
        const userPath = path.join(userdataDir, folder);
        try {
            if (!fs.statSync(userPath).isDirectory()) continue;
        } catch(e) { continue; }
        
        // Method 1: Scan app subfolders in userdata/<id32>/
        try {
            const appFolders = fs.readdirSync(userPath);
            for (const appId of appFolders) {
                if (isNaN(appId) || appId === '7' || appId === '0') continue;
                accountStats[steamId64].gameIds.add(appId);
                if (!gameOwnershipMap[appId]) {
                    gameOwnershipMap[appId] = accountName;
                }
            }
        } catch(e) {}
        
        // Method 2: Parse localconfig.vdf for apps + wallet info
        try {
            const localConfigPath = path.join(userPath, 'config', 'localconfig.vdf');
            if (fs.existsSync(localConfigPath)) {
                const configContent = fs.readFileSync(localConfigPath, 'utf-8');
                const parsed = vdf.parse(configContent);
                const root = parsed.UserLocalConfigStore || parsed.userLocalConfigStore || {};
                const software = root.Software || root.software || {};
                const valve = software.Valve || software.valve || {};
                const steam = valve.Steam || valve.steam || {};
                const apps = steam.apps || steam.Apps || {};
                for (const appId in apps) {
                    if (appId === '0') continue;
                    accountStats[steamId64].gameIds.add(appId);
                    if (!gameOwnershipMap[appId]) {
                        gameOwnershipMap[appId] = accountName;
                    }
                }
                
                // Try to extract wallet/currency info from various possible locations
                const candidates = [
                    root.WalletBalance, root.walletbalance,
                    steam.WalletBalance, steam.walletbalance,
                    root.System?.WalletBalance,
                    steam.News?.WalletBalance
                ].filter(v => v !== undefined);
                if (candidates.length > 0) {
                    accountStats[steamId64].walletBalance = candidates[0];
                }
                
                // Look for currency in News or System
                const currencyCandidates = [
                    root.System?.PreferredCurrency,
                    steam.News?.WalletCurrency,
                    steam.NotifyAvailableGames?.Currency
                ].filter(v => v !== undefined);
                if (currencyCandidates.length > 0) {
                    accountStats[steamId64].walletCurrency = currencyCandidates[0];
                }
            }
        } catch(e) {}
        
        accountStats[steamId64].gameCount = accountStats[steamId64].gameIds.size;
        delete accountStats[steamId64].gameIds; // free memory after counting
    }
    
    _ownershipMapCacheKey = cacheKey;
    console.log(`[Ownership Map] Rebuilt: ${Object.keys(gameOwnershipMap).length} game-account links`);
}

// Resolve game owner: manual > ACF LastOwner > auto-detected map
function resolveGameAccount(gameId, ownerId) {
    // Priority 1: Manual mapping
    if (gameAccounts[gameId]) {
        return gameAccounts[gameId];
    }
    
    // Priority 2: LastOwner from ACF file
    if (ownerId && ownerId !== "0" && ownerId !== "null" && ownerId !== "") {
        if (loginUsers[ownerId]) {
            return loginUsers[ownerId].AccountName;
        }
        // Try as SteamID32 -> SteamID64
        try {
            const steamId64 = BigInt(ownerId) > BigInt("76561197960265728") 
                ? ownerId 
                : (BigInt(ownerId) + BigInt("76561197960265728")).toString();
            if (loginUsers[steamId64]) {
                return loginUsers[steamId64].AccountName;
            }
        } catch(e) {}
    }
    
    // Priority 3: Auto-detected ownership map (userdata + localconfig)
    if (gameOwnershipMap[gameId]) {
        return gameOwnershipMap[gameId];
    }
    
    return null;
}

let isGameBoosterEnabled = localStorage.getItem('nexus_game_booster') === 'true';
let _dropdownCloseHandler = null;

// Game Booster - Default process list
const defaultBoosterProcesses = [
    { name: 'chrome.exe', label: 'Google Chrome', icon: 'fa-brands fa-chrome', enabled: true },
    { name: 'msedge.exe', label: 'Microsoft Edge', icon: 'fa-brands fa-edge', enabled: true },
    { name: 'brave.exe', label: 'Brave', icon: 'fa-solid fa-shield-halved', enabled: true },
    { name: 'firefox.exe', label: 'Firefox', icon: 'fa-brands fa-firefox-browser', enabled: false },
    { name: 'opera.exe', label: 'Opera GX', icon: 'fa-brands fa-opera', enabled: false },
    { name: 'discord.exe', label: 'Discord', icon: 'fa-brands fa-discord', enabled: false },
    { name: 'Spotify.exe', label: 'Spotify', icon: 'fa-brands fa-spotify', enabled: false },
    { name: 'Teams.exe', label: 'Microsoft Teams', icon: 'fa-brands fa-microsoft', enabled: false },
    { name: 'onedrive.exe', label: 'OneDrive', icon: 'fa-solid fa-cloud', enabled: true },
    { name: 'Telegram.exe', label: 'Telegram', icon: 'fa-brands fa-telegram', enabled: false },
];

let boosterProcesses = [];
try {
    const saved = localStorage.getItem('nexus_booster_processes');
    if (saved) {
        boosterProcesses = JSON.parse(saved);
        // Merge any new default processes not in saved list
        defaultBoosterProcesses.forEach(dp => {
            if (!boosterProcesses.find(p => p.name === dp.name)) {
                boosterProcesses.push(dp);
            }
        });
    } else {
        boosterProcesses = JSON.parse(JSON.stringify(defaultBoosterProcesses));
    }
} catch(e) {
    boosterProcesses = JSON.parse(JSON.stringify(defaultBoosterProcesses));
}

function saveBoosterProcesses() {
    localStorage.setItem('nexus_booster_processes', JSON.stringify(boosterProcesses));
}

function getMemoryInfo() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const percent = Math.round((used / total) * 100);
    return {
        totalGB: (total / 1073741824).toFixed(1),
        usedGB: (used / 1073741824).toFixed(1),
        freeGB: (free / 1073741824).toFixed(1),
        percent
    };
}

function updateMemoryUI() {
    const mem = getMemoryInfo();
    const memText = document.getElementById('memoryUsageText');
    const memBar = document.getElementById('memoryBar');
    if (memText) memText.textContent = `${mem.usedGB} GB / ${mem.totalGB} GB (${mem.percent}%)`;
    if (memBar) {
        memBar.style.width = `${mem.percent}%`;
        if (mem.percent > 85) {
            memBar.style.background = 'var(--danger)';
        } else if (mem.percent > 65) {
            memBar.style.background = '#f59e0b';
        } else {
            memBar.style.background = 'var(--success)';
        }
    }
}

function runGameBoost() {
    return new Promise((resolve) => {
        const memBefore = getMemoryInfo();
        const enabledProcesses = boosterProcesses.filter(p => p.enabled);
        if (enabledProcesses.length === 0) return resolve({ freed: 0, killed: 0 });

        const processNames = enabledProcesses.map(p => `/IM ${p.name}`).join(' ');
        exec(`taskkill /F ${processNames}`, () => {
            // Flush standby memory via PowerShell (best-effort)
            exec('powershell -Command "[System.GC]::Collect()"', () => {
                setTimeout(() => {
                    const memAfter = getMemoryInfo();
                    const freedMB = Math.max(0, Math.round((parseFloat(memBefore.usedGB) - parseFloat(memAfter.usedGB)) * 1024));
                    updateMemoryUI();
                    resolve({ freed: freedMB, killed: enabledProcesses.length });
                }, 1500);
            });
        });
    });
}

function showBoostStats(freed, killed) {
    const statsEl = document.getElementById('boostStats');
    const statsText = document.getElementById('boostStatsText');
    if (statsEl && statsText) {
        statsText.textContent = t('settings.boost_stats', 'Boost complete')
            .replace('{freed}', String(freed))
            .replace('{killed}', String(killed));
        statsEl.style.display = 'block';
        setTimeout(() => { statsEl.style.display = 'none'; }, 8000);
    }
}

function renderBoosterProcessList() {
    const listEl = document.getElementById('boosterProcessList');
    if (!listEl) return;
    listEl.innerHTML = '';
    boosterProcesses.forEach((proc, index) => {
        const item = document.createElement('div');
        item.className = 'booster-process-item';
        item.style.cssText = `display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.8rem; background: ${proc.enabled ? 'rgba(59,130,246,0.08)' : 'rgba(255,255,255,0.02)'}; border: 1px solid ${proc.enabled ? 'rgba(59,130,246,0.2)' : 'var(--border)'}; border-radius: 10px; cursor: pointer; transition: all 0.2s; user-select: none;`;
        item.innerHTML = `
            <i class="${proc.icon}" style="font-size: 1.1rem; width: 20px; text-align: center; color: ${proc.enabled ? 'var(--primary)' : 'var(--text-muted)'};"></i>
            <span style="flex: 1; font-size: 0.85rem; color: ${proc.enabled ? 'var(--text-main)' : 'var(--text-muted)'};">${proc.label}</span>
            <i class="fa-solid ${proc.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}" style="font-size: 1.2rem; color: ${proc.enabled ? 'var(--primary)' : 'var(--text-muted)'};"></i>
        `;
        item.addEventListener('click', () => {
            boosterProcesses[index].enabled = !boosterProcesses[index].enabled;
            saveBoosterProcesses();
            renderBoosterProcessList();
        });
        item.addEventListener('mouseenter', () => { item.style.background = proc.enabled ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.05)'; });
        item.addEventListener('mouseleave', () => { item.style.background = proc.enabled ? 'rgba(59,130,246,0.08)' : 'rgba(255,255,255,0.02)'; });
        listEl.appendChild(item);
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    await appInitPromise;
    ipcRenderer.invoke('set-tray-lang', currentLang).catch(() => {});

    // Nav menu switching
    const navItems = document.querySelectorAll('.nav-item');
    const viewSections = document.querySelectorAll('.view-section');
    
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            
            const target = item.getAttribute('data-target');
            
            viewSections.forEach(section => {
                section.style.display = 'none';
                section.classList.remove('active');
            });
            
            const targetSection = document.getElementById(`view-${target}`);
            if (targetSection) {
                targetSection.style.display = 'block';
                targetSection.classList.add('active');
                
                // Update header title using i18n keys
                const titleEl = document.querySelector('.header-text h1') || document.querySelector('.header-title h1');
                const descEl = document.querySelector('.header-text p') || document.querySelector('.header-title p');
                
                if (titleEl && descEl) {
                    titleEl.innerText = t(`header.${target}_title`);
                    descEl.innerText = t(`header.${target}_desc`);
                }
                
                // Lazy-load games list when first visited
                if (target === 'games') {
                    const grid = document.getElementById('installedGamesGrid');
                    if (grid && grid.children.length <= 1) {
                        loadInstalledGames();
                    }
                }
            }
        });
    });

    // Unified Launcher Logic
    const launchBtns = document.querySelectorAll('.launch-platform-btn');
    launchBtns.forEach(btn => {
        const launchLabel = btn.getAttribute('data-i18n-label') ? t(btn.getAttribute('data-i18n-label')) : t('launcher.launch');
        btn.setAttribute('data-launch-label', launchLabel);
        btn.addEventListener('click', () => {
            const platform = btn.getAttribute('data-platform');
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t('launcher.launching')}`;
            
            if (platform === 'steam') {
                exec('start steam://');
            } else if (platform === 'epic') {
                exec('start com.epicgames.launcher://');
            } else if (platform === 'battlenet') {
                exec('start battlenet://');
            } else if (platform === 'xbox') {
                exec('start xbox:');
            } else if (platform === 'ea') {
                const eaPath = 'C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe';
                if (fs.existsSync(eaPath)) {
                    exec(`start "" "${eaPath}"`);
                } else {
                    exec('start origin2://');
                }
            }
            
            setTimeout(() => {
                btn.innerHTML = btn.getAttribute('data-launch-label') || t('launcher.launch');
            }, 2000);
        });
    });

    // Backup Logic
    const btnBackup = document.getElementById('btnBackup');
    const btnRestore = document.getElementById('btnRestore');
    const backupStatus = document.getElementById('backupStatus');

    if (btnBackup) {
        btnBackup.addEventListener('click', async () => {
            if (!steamPath) return;
            btnBackup.disabled = true;
            btnBackup.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t('backup.backing_up')}`;
            backupStatus.innerText = t('backup.steam_copying');
            
            try {
                const backupDir = path.join(os.homedir(), 'Documents', 'NexusSteamBackup');
                if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
                
                // Backup config
                await fs.promises.cp(path.join(steamPath, 'config'), path.join(backupDir, 'config'), { recursive: true, force: true });
                // Backup userdata (can be large, but important)
                await fs.promises.cp(path.join(steamPath, 'userdata'), path.join(backupDir, 'userdata'), { recursive: true, force: true });
                
                backupStatus.innerText = t('backup.steam_success');
                backupStatus.style.color = 'var(--success)';
            } catch (err) {
                console.error(err);
                backupStatus.innerText = t('backup.error');
                backupStatus.style.color = 'var(--danger)';
            }
            
            btnBackup.disabled = false;
            btnBackup.innerHTML = `<i class="fa-solid fa-copy"></i> ${t('backup.steam_backup_btn')}`;
        });
    }

    if (btnRestore) {
        btnRestore.addEventListener('click', async () => {
            if (!steamPath) return;
            const backupDir = path.join(os.homedir(), 'Documents', 'NexusSteamBackup');
            if (!fs.existsSync(backupDir)) {
                backupStatus.innerText = t('backup.steam_no_backup');
                backupStatus.style.color = 'var(--danger)';
                return;
            }
            
            btnRestore.disabled = true;
            btnRestore.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t('backup.restoring')}`;
            backupStatus.innerText = t('backup.steam_restoring');
            
            try {
                // Kill steam first
                exec('taskkill /F /IM steam.exe /IM steamwebhelper.exe /T', async () => {
                    await fs.promises.cp(path.join(backupDir, 'config'), path.join(steamPath, 'config'), { recursive: true, force: true });
                    await fs.promises.cp(path.join(backupDir, 'userdata'), path.join(steamPath, 'userdata'), { recursive: true, force: true });
                    
                    backupStatus.innerText = t('backup.steam_restore_success');
                    backupStatus.style.color = 'var(--success)';
                    btnRestore.disabled = false;
                    btnRestore.innerHTML = `<i class="fa-solid fa-rotate-left"></i> ${t('backup.steam_restore_btn')}`;
                    loadSteamAccounts();
                });
            } catch (err) {
                console.error(err);
                backupStatus.innerText = t('backup.error');
                backupStatus.style.color = 'var(--danger)';
                btnRestore.disabled = false;
                btnRestore.innerHTML = `<i class="fa-solid fa-rotate-left"></i> ${t('backup.steam_restore_btn')}`;
            }
        });
    }

    // Refresh Button Logic
    const refreshBtn = document.getElementById('refreshAccountsBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            const icon = refreshBtn.querySelector('i');
            icon.classList.add('fa-spin');
            refreshBtn.disabled = true;
            try {
                await loadSteamAccounts();
                if (typeof renderPlatformAccountsSections === 'function') {
                    await renderPlatformAccountsSections();
                }
            } catch (e) { console.error(e); }
            setTimeout(() => {
                icon.classList.remove('fa-spin');
                refreshBtn.disabled = false;
            }, 500);
        });
    }

    // Modal Logic
    const addAccountBtn = document.getElementById('addAccountBtn');
    const addAccountModal = document.getElementById('addAccountModal');
    const addAccountModalPanel = document.getElementById('addAccountModalPanel');
    const platformSelectBtns = document.querySelectorAll('.platform-select-btn');
    const steamAddInstructions = document.getElementById('steamAddInstructions');
    const otherAddInstructions = document.getElementById('otherAddInstructions');
    const addAccountNameGroup = document.getElementById('addAccountNameGroup');
    const addModalStepHint = document.getElementById('addModalStepHint');
    const addModalBusyText = document.getElementById('addModalBusyText');
    const otherAccountNameInput = document.getElementById('otherAccountNameInput');
    const saveSessionBtn = document.getElementById('saveSessionBtn');
    const openLauncherFromAddModalBtn = document.getElementById('openLauncherFromAddModalBtn');
    const okAddModalBtn = document.getElementById('okAddModalBtn');
    const cancelAddModalBtn = document.getElementById('cancelAddModalBtn');
    let selectedAddPlatform = 'epic';
    let isSavingPlatformSession = false;

    function generateAutoPlatformAccountName(platform) {
        const base = PLATFORM_META?.[platform]?.name || platform;
        const existing = Array.isArray(platformAccountsCatalog?.[platform]) ? platformAccountsCatalog[platform] : [];
        let i = 1;
        while (existing.includes(`${base} ${i}`)) i++;
        return `${base} ${i}`;
    }

    function resetSaveSessionUi() {
        isSavingPlatformSession = false;
        if (saveSessionBtn) {
            saveSessionBtn.disabled = false;
            saveSessionBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> <span>${t('modal.save_session')}</span>`;
        }
        if (addAccountModalPanel) addAccountModalPanel.classList.remove('add-account-modal--busy');
        if (addModalBusyText) addModalBusyText.style.display = 'none';
        if (otherAccountNameInput) {
            otherAccountNameInput.disabled = false;
            otherAccountNameInput.readOnly = false;
        }
    }

    function setAddModalPlatform(plat) {
        selectedAddPlatform = plat;
        platformSelectBtns.forEach(b => {
            const active = b.getAttribute('data-plat') === plat;
            b.classList.toggle('active', active);
            b.style.borderColor = active ? 'var(--primary)' : 'var(--border)';
            b.style.background = active ? 'rgba(96, 205, 255, 0.1)' : 'transparent';
        });
        const isSteam = plat === 'steam';
        if (steamAddInstructions) steamAddInstructions.style.display = isSteam ? 'block' : 'none';
        if (otherAddInstructions) otherAddInstructions.style.display = isSteam ? 'none' : 'block';
        if (addAccountNameGroup) addAccountNameGroup.style.display = isSteam ? 'none' : 'block';
        if (addModalStepHint) addModalStepHint.style.display = isSteam ? 'none' : 'block';
        if (saveSessionBtn) saveSessionBtn.style.display = isSteam ? 'none' : 'inline-flex';
        if (openLauncherFromAddModalBtn) openLauncherFromAddModalBtn.style.display = isSteam ? 'none' : 'inline-flex';
        if (okAddModalBtn) okAddModalBtn.style.display = isSteam ? 'inline-flex' : 'none';
        if (!isSteam && otherAccountNameInput) {
            setTimeout(() => {
                otherAccountNameInput.focus();
                otherAccountNameInput.select();
            }, 80);
        }
    }

    window.openAddAccountModal = function openAddAccountModal(plat = 'epic') {
        if (!addAccountModal) return;
        // Ensure other overlays don't block typing/clicks
        document.getElementById('notesModalOverlay')?.remove();
        document.getElementById('gameInfoOverlay')?.remove();
        addAccountModal.style.zIndex = '100000';
        resetSaveSessionUi();
        setAddModalPlatform(plat);
        addAccountModal.classList.add('active');
    };

    function closeAddAccountModal() {
        if (isSavingPlatformSession) return;
        addAccountModal?.classList.remove('active');
        resetSaveSessionUi();
    }

    if (addAccountBtn && addAccountModal) {
        addAccountBtn.addEventListener('click', () => window.openAddAccountModal('epic'));
    }

    if (addAccountModal) {
        addAccountModal.addEventListener('click', (e) => {
            if (e.target === addAccountModal) closeAddAccountModal();
        });
    }
    if (addAccountModalPanel) {
        addAccountModalPanel.addEventListener('click', (e) => e.stopPropagation());
    }

    cancelAddModalBtn?.addEventListener('click', closeAddAccountModal);
    okAddModalBtn?.addEventListener('click', closeAddAccountModal);
    openLauncherFromAddModalBtn?.addEventListener('click', () => {
        try { launchPlatformApp(selectedAddPlatform); } catch (e) {}
        showToast(t('modal.open_launcher_hint'), 'info', { duration: 3500 });
        setTimeout(() => otherAccountNameInput?.focus(), 200);
    });
    document.querySelectorAll('#addAccountModal .close-modal').forEach(btn => {
        btn.addEventListener('click', closeAddAccountModal);
    });

    platformSelectBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const plat = btn.getAttribute('data-plat');
            setAddModalPlatform(plat);
            if (plat !== 'steam' && otherAccountNameInput && !otherAccountNameInput.value.trim()) {
                otherAccountNameInput.value = '';
            }
        });
    });

    ipcRenderer.on('platform-session-progress', (_e, data) => {
        if (!addModalBusyText || !data) return;
        addModalBusyText.style.display = 'block';
        addModalBusyText.textContent = t('modal.saving_session');
    });

    if (saveSessionBtn) {
        saveSessionBtn.addEventListener('click', async () => {
            if (isSavingPlatformSession) return;
            let accName = (otherAccountNameInput?.value || '').trim();
            if (!accName) {
                accName = generateAutoPlatformAccountName(selectedAddPlatform);
                if (otherAccountNameInput) otherAccountNameInput.value = accName;
            }

            isSavingPlatformSession = true;
            saveSessionBtn.disabled = true;
            saveSessionBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t('common.loading')}`;
            if (addAccountModalPanel) addAccountModalPanel.classList.add('add-account-modal--busy');
            if (addModalBusyText) {
                addModalBusyText.style.display = 'block';
                addModalBusyText.textContent = t('modal.saving_session');
            }

            try {
                const res = await ipcRenderer.invoke('save-platform-session', selectedAddPlatform, accName);
                if (res.success) {
                    mergePlatformAccountList(selectedAddPlatform, [accName]);
                    const saveMsg = selectedAddPlatform === 'epic'
                        ? t('platform.epic_save_hint')
                        : (currentLang === 'ar' ? 'تم حفظ الجلسة بنجاح!' : 'Session saved successfully!');
                    showToast(saveMsg, 'success', { duration: selectedAddPlatform === 'epic' ? 6000 : 3500 });
                    closeAddAccountModal();
                    await loadSteamAccounts();
                    if (typeof renderPlatformAccountsSections === 'function') await renderPlatformAccountsSections();
                } else {
                    showToast(res.error, 'error');
                }
            } catch (e) {
                showToast(e.message, 'error');
            } finally {
                resetSaveSessionUi();
            }
        });
    }

    // Settings Logic
    const toggleAutoStartBtn = document.getElementById('toggleAutoStart');
    if (toggleAutoStartBtn) {
        // Get initial state
        ipcRenderer.invoke('get-autostart').then(isEnabled => {
            updateAutoStartBtn(toggleAutoStartBtn, isEnabled);
        });

        toggleAutoStartBtn.addEventListener('click', async () => {
            const currentState = toggleAutoStartBtn.classList.contains('active-acc-btn');
            toggleAutoStartBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            const newState = await ipcRenderer.invoke('set-autostart', !currentState);
            updateAutoStartBtn(toggleAutoStartBtn, newState);
        });
    }

    function updateAutoStartBtn(btn, isEnabled) {
        if (isEnabled) {
            btn.innerHTML = `<i class="fa-solid fa-toggle-on"></i> ${t('settings.enabled')}`;
            btn.classList.add('active-acc-btn');
        } else {
            btn.innerHTML = `<i class="fa-solid fa-toggle-off"></i> ${t('settings.disabled')}`;
            btn.classList.remove('active-acc-btn');
        }
    }

    // Filter & Search Logic
    const searchInput = document.getElementById('gameSearchInput');
    const platformFilter = document.getElementById('platformFilter');
    
    function filterGames() {
        if (!searchInput || !platformFilter) return;
        const query = (searchInput.value || '').toLowerCase();
        const platform = platformFilter.value;
        const gameCards = document.querySelectorAll('#installedGamesGrid .account-card');
        
        gameCards.forEach(card => {
            const btn = card.querySelector('.launch-game-btn');
            if (!btn) return;
            
            const matchName = card.innerText.toLowerCase().includes(query);
            const cardPlatform = btn.getAttribute('data-platform');
            const matchPlatform = platform === 'all' || cardPlatform === platform;
            
            if (matchName && matchPlatform) {
                card.style.display = 'block';
            } else {
                card.style.display = 'none';
            }
        });
    }

    if (searchInput) searchInput.addEventListener('input', filterGames);
    if (platformFilter) platformFilter.addEventListener('change', filterGames);

    // Theme Logic
    const colorBtns = document.querySelectorAll('.color-btn');
    const root = document.documentElement;
    
    // Load saved theme
    const savedColor = localStorage.getItem('nexus_theme_color');
    if (savedColor) {
        root.style.setProperty('--primary', savedColor);
        updateColorButtons(savedColor);
    }
    
    colorBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const color = btn.getAttribute('data-color');
            root.style.setProperty('--primary', color);
            localStorage.setItem('nexus_theme_color', color);
            updateColorButtons(color);
        });
    });
    
    function updateColorButtons(activeColor) {
        colorBtns.forEach(btn => {
            if (btn.getAttribute('data-color') === activeColor) {
                btn.style.border = '2px solid white';
                btn.style.transform = 'scale(1.1)';
            } else {
                btn.style.border = '2px solid transparent';
                btn.style.transform = 'scale(1)';
            }
        });
    }

    // View Toggle Logic
    const viewBtns = document.querySelectorAll('.view-toggle-btn');
    const gridsToToggle = ['accountsGrid', 'installedGamesGrid'];
    
    // Load saved view
    const savedView = localStorage.getItem('nexus_view_mode') || 'grid';
    applyViewMode(savedView);
    
    viewBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const view = btn.getAttribute('data-view');
            applyViewMode(view);
            localStorage.setItem('nexus_view_mode', view);
        });
    });
    
    function applyViewMode(view) {
        // Update buttons
        viewBtns.forEach(btn => {
            if (btn.getAttribute('data-view') === view) {
                btn.classList.add('active');
                btn.style.color = 'var(--primary)';
            } else {
                btn.classList.remove('active');
                btn.style.color = 'var(--text-muted)';
            }
        });
        
        // Update grids
        gridsToToggle.forEach(gridId => {
            const grid = document.getElementById(gridId);
            if (grid) {
                if (view === 'list') {
                    grid.classList.add('list-view');
                } else {
                    grid.classList.remove('list-view');
                }
            }
        });
    }

    // Game Booster UI Logic
    const toggleGameBoosterBtn = document.getElementById('toggleGameBooster');
    const boosterSection = document.getElementById('boosterSection');
    const manualBoostBtn = document.getElementById('manualBoostBtn');

    function updateGameBoosterUI() {
        if (toggleGameBoosterBtn) {
            if (isGameBoosterEnabled) {
                toggleGameBoosterBtn.innerHTML = `<i class="fa-solid fa-rocket" style="color: var(--success);"></i> <span style="color: var(--success);">${t('settings.enabled')}</span>`;
                toggleGameBoosterBtn.style.borderColor = 'var(--success)';
                toggleGameBoosterBtn.style.background = 'rgba(16,185,129,0.1)';
                if (boosterSection) boosterSection.style.display = 'block';
            } else {
                toggleGameBoosterBtn.innerHTML = `<i class="fa-solid fa-power-off"></i> <span>${t('settings.disabled')}</span>`;
                toggleGameBoosterBtn.style.borderColor = 'var(--border)';
                toggleGameBoosterBtn.style.background = 'rgba(255,255,255,0.05)';
                if (boosterSection) boosterSection.style.display = 'none';
            }
        }
    }
    
    if (toggleGameBoosterBtn) {
        toggleGameBoosterBtn.addEventListener('click', () => {
            isGameBoosterEnabled = !isGameBoosterEnabled;
            localStorage.setItem('nexus_game_booster', isGameBoosterEnabled);
            updateGameBoosterUI();
            renderBoosterProcessList();
        });
        updateGameBoosterUI();
        renderBoosterProcessList();
    }

    // Manual Boost Button
    if (manualBoostBtn) {
        manualBoostBtn.addEventListener('click', async () => {
            manualBoostBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t('game.boosting')}`;
            manualBoostBtn.style.pointerEvents = 'none';
            const result = await runGameBoost();
            showBoostStats(result.freed, result.killed);
        });
    }

    // Update Checker
    const checkUpdateBtn = document.getElementById('checkUpdateBtn');
    const updateStatus = document.getElementById('updateStatus');
    if (checkUpdateBtn) {
        checkUpdateBtn.addEventListener('click', async () => {
            const btnText = typeof t === 'function' ? t('settings.check_updates') : 'البحث عن تحديثات';
            checkUpdateBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + btnText;
            checkUpdateBtn.disabled = true;
            if (updateStatus) updateStatus.innerHTML = '';

            try {
                const res = await ipcRenderer.invoke('check-updates');
                const isAr = typeof currentLang !== 'undefined' ? currentLang === 'ar' : true;
                
                if (res.success) {
                    if (res.hasUpdate) {
                        updateStatus.innerHTML = `
                            <div style="padding: 0.75rem; background: rgba(108, 203, 95, 0.1); border: 1px solid rgba(108, 203, 95, 0.3); border-radius: var(--radius-sm);">
                                <strong style="color: var(--success);"><i class="fa-solid fa-circle-check"></i> ${isAr ? 'يتوفر تحديث جديد!' : 'Update Available!'} (v${res.latest})</strong>
                                <p style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem;">${isAr ? 'الإصدار الحالي:' : 'Current Version:'} v${res.current}</p>
                                <button class="btn btn-primary" id="downloadUpdateBtn" data-url="${res.url}" style="margin-top: 0.5rem; padding: 0.4rem 0.75rem; font-size: 0.85rem;">
                                    <i class="fa-solid fa-download"></i> ${isAr ? 'تحميل التحديث' : 'Download Update'}
                                </button>
                            </div>
                        `;
                        const downloadBtn = document.getElementById('downloadUpdateBtn');
                        if (downloadBtn) {
                            downloadBtn.addEventListener('click', () => {
                                ipcRenderer.invoke('open-external', downloadBtn.getAttribute('data-url'));
                            });
                        }
                    } else {
                        updateStatus.innerHTML = `
                            <div style="padding: 0.75rem; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border); border-radius: var(--radius-sm);">
                                <strong><i class="fa-solid fa-check" style="color: var(--text-muted);"></i> ${isAr ? 'أنت تستخدم أحدث إصدار' : 'You are using the latest version'}</strong>
                                <p style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem;">v${res.current}</p>
                            </div>
                        `;
                    }
                } else {
                    updateStatus.innerHTML = `
                        <div style="padding: 0.75rem; background: rgba(255, 71, 71, 0.1); border: 1px solid rgba(255, 71, 71, 0.3); border-radius: var(--radius-sm);">
                            <strong style="color: var(--danger);"><i class="fa-solid fa-circle-exclamation"></i> ${isAr ? 'حدث خطأ أثناء البحث عن تحديثات' : 'Error checking for updates'}</strong>
                        </div>
                    `;
                }
            } catch (err) {
                const isAr = typeof currentLang !== 'undefined' ? currentLang === 'ar' : true;
                if (updateStatus) updateStatus.innerHTML = `<span style="color: var(--danger);">${isAr ? 'خطأ في الاتصال' : 'Connection error'}</span>`;
            }

            checkUpdateBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> <span data-i18n="settings.check_updates">' + btnText + '</span>';
            checkUpdateBtn.disabled = false;
        });
    }


    await loadSteamAccounts();
    await renderPlatformAccountsSections();
});

// NOTE: Automatic polling removed by request. Use refreshAccountsBtn for manual refresh.

function normalizeSteamUsers(users) {
    if (!users || typeof users !== 'object') return {};
    const result = {};
    for (const steamId of Object.keys(users)) {
        const u = users[steamId];
        if (u && typeof u === 'object' && u.AccountName) {
            result[steamId] = u;
        }
    }
    return result;
}

function parseLoginUsersFromVdf(vdfContent) {
    try {
        const parsed = vdf.parse(vdfContent);
        if (parsed.users) return normalizeSteamUsers(parsed.users);
        if (parsed.Users) return normalizeSteamUsers(parsed.Users);
        return normalizeSteamUsers(parsed);
    } catch (e) {
        return {};
    }
}

function saveSteamAccountsCatalog() {
    if (steamCatalogFile) {
        writeEncryptedJson(steamCatalogFile, steamAccountsCatalog);
    }
}

function persistCatalogFromUsers(users) {
    let changed = false;
    for (const steamId of Object.keys(users)) {
        const u = users[steamId];
        if (!u || !u.AccountName) continue;
        if (!steamAccountsCatalog[steamId]) {
            steamAccountsCatalog[steamId] = {};
            changed = true;
        }
        const prev = JSON.stringify(steamAccountsCatalog[steamId]);
        steamAccountsCatalog[steamId] = {
            ...steamAccountsCatalog[steamId],
            AccountName: u.AccountName,
            PersonaName: u.PersonaName || steamAccountsCatalog[steamId].PersonaName || u.AccountName,
            MostRecent: u.MostRecent,
            RememberPassword: u.RememberPassword,
            AllowAutoLogin: u.AllowAutoLogin
        };
        if (JSON.stringify(steamAccountsCatalog[steamId]) !== prev) changed = true;
    }
    if (changed) saveSteamAccountsCatalog();
}

function buildDisplayUsers(freshUsers) {
    persistCatalogFromUsers(freshUsers);

    const display = JSON.parse(JSON.stringify(steamAccountsCatalog));

    for (const steamId of Object.keys(freshUsers)) {
        display[steamId] = {
            ...display[steamId],
            ...freshUsers[steamId]
        };
    }

    if (Object.keys(display).length === 0 && Object.keys(freshUsers).length > 0) {
        return { ...freshUsers };
    }

    return display;
}

function snapshotSteamAccountsBeforeSwitch() {
    persistCatalogFromUsers(loginUsers);
    if (!steamPath) return;
    const vdfPath = path.join(steamPath, 'config', 'loginusers.vdf');
    if (!fs.existsSync(vdfPath)) return;
    try {
        const content = fs.readFileSync(vdfPath, 'utf-8');
        persistCatalogFromUsers(parseLoginUsersFromVdf(content));
    } catch (e) {}
}

async function reloadAccountsAfterSwitch() {
    const delays = [1500, 4000, 8000, 12000];
    for (const ms of delays) {
        await new Promise(r => setTimeout(r, ms));
        await loadSteamAccounts();
        if (typeof renderPlatformAccountsSections === 'function') await renderPlatformAccountsSections();
    }
    isSwitchingAccount = false;
}

async function loadSteamAccounts() {
    steamPath = await ipcRenderer.invoke('get-steam-path');
    if (!steamPath) {
        document.getElementById('accountsGrid').innerHTML = `<div class="info-box"><p>${t('steam.path_not_found')}</p></div>`;
        return;
    }

    const vdfPath = path.join(steamPath, 'config', 'loginusers.vdf');
    
    // NOTE: fs.watch() auto-reload removed by request. Use refreshAccountsBtn for manual refresh.
    try {
        const vdfContent = fs.readFileSync(vdfPath, 'utf-8');
        const freshUsers = parseLoginUsersFromVdf(vdfContent);
        loginUsers = buildDisplayUsers(freshUsers);
        await renderAccountsGrid(loginUsers);
    } catch (error) {
        console.error('Error reading loginusers.vdf:', error);
    }
}

function getAccountAvatarHtml(steamId, personaName) {
    let avatarHtml = `<span>${personaName.charAt(0).toUpperCase()}</span>`;
    if (steamPath) {
        const avatarPath = path.join(steamPath, 'config', 'avatarcache', `${steamId}.png`);
        if (fs.existsSync(avatarPath)) {
            try {
                const base64Data = fs.readFileSync(avatarPath, 'base64');
                avatarHtml = `<img src="data:image/png;base64,${base64Data}" alt="">`;
            } catch (e) {}
        }
    }
    return avatarHtml;
}

function renderSessionHero(heroEl, session, users, hasActiveSession, accountCount = 0) {
    if (!heroEl) return;

    if (hasActiveSession) {
        let activeSteamId = null;
        let activeUser = null;
        for (const steamId of Object.keys(users)) {
            if (users[steamId].AccountName === session.accountName) {
                activeSteamId = steamId;
                activeUser = users[steamId];
                break;
            }
        }
        if (!activeUser) return;

        const personaName = activeUser.PersonaName || activeUser.AccountName;
        const stats = accountStats[activeSteamId] || { gameCount: 0, walletBalance: null };
        const avatarHtml = getAccountAvatarHtml(activeSteamId, personaName);
        let walletLine = '';
        if (stats.walletBalance !== null && stats.walletBalance !== undefined) {
            const balance = (parseInt(stats.walletBalance) / 100).toFixed(2);
            walletLine = `<span class="meta-item"><i class="fa-solid fa-wallet"></i> ${balance}</span>`;
        }

        heroEl.innerHTML = `
            <div class="session-hero session-hero--active">
                <div class="session-hero-bg"></div>
                <div class="session-hero-content">
                    <div class="session-hero-avatar">${avatarHtml}</div>
                    <div class="session-hero-info">
                        <span class="session-badge session-badge--online"><span class="pulse-dot"></span> ${t('account.logged_in')}</span>
                        <h2>${personaName}</h2>
                        <div class="session-hero-meta">
                            <span class="meta-item"><i class="fa-solid fa-user"></i> ${activeUser.AccountName}</span>
                            <span class="meta-item"><i class="fa-solid fa-gamepad"></i> ${stats.gameCount} ${t('account.games_owned')}</span>
                            ${walletLine}
                            <span class="meta-item"><i class="fa-brands fa-steam"></i> ${t('steam.steam_online')}</span>
                        </div>
                    </div>
                    <div class="session-hero-actions">
                        <button class="btn btn-primary" id="openSteamProfileBtn" type="button">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> ${t('account.open_profile')}
                        </button>
                    </div>
                </div>
            </div>`;
        document.getElementById('openSteamProfileBtn')?.addEventListener('click', () => {
            ipcRenderer.invoke('open-external', `https://steamcommunity.com/profiles/${activeSteamId}/`);
        });
        return;
    }

    const steamStatus = session.steamRunning ? t('steam.steam_online') : t('steam.steam_offline');
    const badgeClass = session.steamRunning ? 'session-badge--login' : 'session-badge--offline';
    const compactClass = accountCount > 0 ? ' session-hero--compact' : '';
    const idleDesc = accountCount > 0
        ? t('steam.offline_pick_account').replace('{n}', String(accountCount))
        : t('steam.no_session_desc');
    const ctaHtml = accountCount > 0
        ? `<button class="btn btn-primary" id="scrollToAccountsBtn" type="button">
                <i class="fa-solid fa-arrow-down"></i> ${t('steam.show_accounts')}
           </button>`
        : `<button class="btn btn-primary" id="openSteamLoginBtn" type="button">
                <i class="fa-brands fa-steam"></i> ${t('steam.open_steam_login')}
           </button>`;

    heroEl.innerHTML = `
        <div class="session-hero session-hero--idle${compactClass}">
            <div class="session-hero-bg"></div>
            <div class="session-hero-content">
                <div class="session-hero-icon-wrap"><i class="fa-brands fa-steam"></i></div>
                <div class="session-hero-info">
                    <span class="session-badge ${badgeClass}">${steamStatus}</span>
                    <h2>${t('steam.no_session_title')}</h2>
                    <p style="color: var(--text-muted); font-size: 0.9rem; margin: 0; max-width: 520px;">${idleDesc}</p>
                </div>
                <div class="session-hero-actions">
                    ${ctaHtml}
                </div>
            </div>
        </div>`;
    document.getElementById('openSteamLoginBtn')?.addEventListener('click', () => exec('start steam://'));
    document.getElementById('scrollToAccountsBtn')?.addEventListener('click', () => {
        const label = document.getElementById('accountsSectionLabel');
        const target = label && label.style.display !== 'none' ? label : document.getElementById('accountsGrid');
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

function createAccountCard(steamId, user, { hasActiveSession, isCurrent, pickMode }) {
    const personaName = user.PersonaName || user.AccountName;
    const stats = accountStats[steamId] || { gameCount: 0, walletBalance: null };
    const hasNotes = accountNotes[steamId] && accountNotes[steamId].trim().length > 0;
    const avatarHtml = getAccountAvatarHtml(steamId, personaName);

    let walletHtml = '';
    if (stats.walletBalance !== null && stats.walletBalance !== undefined) {
        const balance = (parseInt(stats.walletBalance) / 100).toFixed(2);
        walletHtml = `<span class="stat-pill" title="${t('account.wallet_balance')}"><i class="fa-solid fa-wallet"></i> ${balance}</span>`;
    }

    let actionHtml;
    let loginHint = '';
    if (isCurrent) {
        actionHtml = `<button class="btn btn-switch disabled" disabled><i class="fa-solid fa-circle-check"></i> ${t('account.logged_in')}</button>`;
    } else if (!hasActiveSession) {
        actionHtml = `<button class="btn btn-login-acc login-acc-btn" data-account="${user.AccountName}">
            <i class="fa-solid fa-right-to-bracket"></i> ${t('account.login')}
        </button>`;
        loginHint = `<p class="card-login-hint">${t('account.login_hint')}</p>`;
    } else {
        actionHtml = `<button class="btn btn-switch-acc switch-acc-btn" data-account="${user.AccountName}">
            <i class="fa-solid fa-arrow-right-arrow-left"></i> ${t('account.switch')}
        </button>`;
    }

    const card = document.createElement('div');
    card.className = `account-card${pickMode ? ' account-card--pick' : ''}${hasActiveSession && !isCurrent ? ' account-card--other' : ''}${isCurrent ? ' active-account' : ''}`;

    card.innerHTML = `
        <div class="card-header">
            <div class="profile-pic placeholder-pic" style="padding: 0;">${avatarHtml}</div>
            <button class="btn-icon notes-btn ${hasNotes ? 'has-notes' : ''}" data-steamid="${steamId}" data-persona="${personaName}" title="${t('account.notes')}" style="position: absolute; top: 0; left: 0; width: 28px; height: 28px; opacity: ${hasNotes ? '1' : '0'}; transition: opacity 0.2s;">
                <i class="fa-solid ${hasNotes ? 'fa-note-sticky' : 'fa-pen-to-square'}" style="font-size: 0.75rem;"></i>
            </button>
        </div>
        <div class="card-body">
            <h3>${personaName}</h3>
            <p class="steam-id">${user.AccountName}</p>
            <div class="card-stats" style="display: flex; gap: 0.4rem; flex-wrap: wrap; justify-content: center; margin-top: 0.5rem;">
                <span class="stat-pill"><i class="fa-solid fa-gamepad"></i> ${stats.gameCount} ${t('account.games_owned')}</span>
                ${walletHtml}
            </div>
            ${loginHint}
        </div>
        <div class="card-actions">
            ${actionHtml}
            <button class="btn-icon dropdown-toggle" data-steamid="${steamId}">
                <i class="fa-solid fa-ellipsis-vertical"></i>
            </button>
        </div>`;
    return card;
}

async function renderAccountsGrid(users) {
    const grid = document.getElementById('accountsGrid');
    const heroEl = document.getElementById('accountsHero');
    const sectionLabel = document.getElementById('accountsSectionLabel');
    const headerDesc = document.querySelector('.header-text p');

    grid.innerHTML = '';
    if (heroEl) heroEl.innerHTML = '';
    if (sectionLabel) sectionLabel.style.display = 'none';
    grid.classList.add('accounts-grid--with-hero');

    buildGameOwnershipMap();

    const steamIds = Object.keys(users);

    if (steamIds.length === 0) {
        if (heroEl) {
            heroEl.innerHTML = `
                <div class="session-hero session-hero--idle">
                    <div class="session-hero-bg"></div>
                    <div class="session-hero-content">
                        <div class="session-hero-icon-wrap"><i class="fa-brands fa-steam"></i></div>
                        <div class="session-hero-info">
                            <h2>${t('steam.no_accounts')}</h2>
                            <p style="color: var(--text-muted); font-size: 0.9rem;">${t('steam.no_session_desc')}</p>
                        </div>
                        <div class="session-hero-actions">
                            <button class="btn btn-primary" id="openSteamLoginBtn" type="button"><i class="fa-brands fa-steam"></i> ${t('steam.open_steam_login')}</button>
                        </div>
                    </div>
                </div>`;
            document.getElementById('openSteamLoginBtn')?.addEventListener('click', () => exec('start steam://'));
        }
        if (headerDesc) headerDesc.textContent = t('steam.no_session_desc');
        return;
    }

    const session = await getActiveSteamSession(users);
    const hasActiveSession = session.active && session.accountName;

    renderSessionHero(heroEl, session, users, hasActiveSession, steamIds.length);

    if (headerDesc) {
        headerDesc.textContent = hasActiveSession ? t('steam.session_active_desc') : t('steam.no_session_desc');
    }

    const sortedIds = [...steamIds].sort((a, b) => {
        const nameA = users[a].AccountName;
        const nameB = users[b].AccountName;
        if (hasActiveSession) {
            if (nameA === session.accountName) return -1;
            if (nameB === session.accountName) return 1;
        }
        return (users[a].PersonaName || nameA).localeCompare(users[b].PersonaName || nameB, currentLang);
    });

    const otherCount = hasActiveSession
        ? sortedIds.filter(id => users[id].AccountName !== session.accountName).length
        : sortedIds.length;

    if (sectionLabel && sortedIds.length > 0) {
        sectionLabel.style.display = 'flex';
        if (!hasActiveSession) {
            sectionLabel.textContent = t('account.choose_account');
        } else if (otherCount > 0) {
            sectionLabel.textContent = t('account.all_accounts');
        } else {
            sectionLabel.style.display = 'none';
        }
    }

    const pickMode = !hasActiveSession;
    sortedIds.forEach(steamId => {
        const user = users[steamId];
        const isCurrent = hasActiveSession && user.AccountName === session.accountName;
        grid.appendChild(createAccountCard(steamId, user, { hasActiveSession, isCurrent, pickMode }));
    });
    
    // Notes button handler
    document.querySelectorAll('.notes-btn').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const steamId = this.getAttribute('data-steamid');
            const persona = this.getAttribute('data-persona');
            openNotesModal(steamId, persona);
        });
    });

    // Handle Dropdowns (fixed positioning on body)
    const dropdownToggles = document.querySelectorAll('.dropdown-toggle');
    dropdownToggles.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            
            // Remove any existing dropdown
            const existing = document.querySelector('.dropdown-popup');
            if (existing) { existing.remove(); return; }
            
            const steamId = btn.getAttribute('data-steamid');
            const btnRect = btn.getBoundingClientRect();
            
            const popup = document.createElement('div');
            popup.className = 'dropdown-popup';
            popup.style.cssText = `position: fixed; top: ${btnRect.top - 6}px; left: ${btnRect.left}px; transform: translateY(-100%); background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 10px; padding: 0.5rem; z-index: 999; box-shadow: 0 10px 25px rgba(0,0,0,0.5); min-width: 170px; direction: rtl;`;
            popup.innerHTML = `
                <button class="btn copy-id-btn" data-id="${steamId}" style="width: 100%; justify-content: flex-start; background: transparent; color: var(--text-main); border: none; padding: 0.5rem; font-size: 0.9rem; cursor: pointer; border-radius: 6px; display: flex; align-items: center; gap: 0.5rem; font-family: inherit;">
                    <i class="fa-regular fa-copy" style="color: var(--primary);"></i> ${t('account.copy_id')}
                </button>
                <hr style="border: 0; border-top: 1px solid var(--border); margin: 0.3rem 0;">
                <button class="btn delete-acc-btn" data-id="${steamId}" style="width: 100%; justify-content: flex-start; background: transparent; color: var(--danger); border: none; padding: 0.5rem; font-size: 0.9rem; cursor: pointer; border-radius: 6px; display: flex; align-items: center; gap: 0.5rem; font-family: inherit;">
                    <i class="fa-solid fa-trash"></i> ${t('account.delete')}
                </button>
            `;
            document.body.appendChild(popup);
            
            // Keep in viewport
            requestAnimationFrame(() => {
                const popupRect = popup.getBoundingClientRect();
                if (popupRect.top < 0) {
                    popup.style.top = `${btnRect.bottom + 6}px`;
                    popup.style.transform = 'none';
                }
            });
            
            // Copy ID handler
            popup.querySelector('.copy-id-btn').addEventListener('click', () => {
                navigator.clipboard.writeText(steamId);
                showToast(t('toast.copied_clipboard'), 'success');
                const copyBtn = popup.querySelector('.copy-id-btn');
                copyBtn.innerHTML = `<i class="fa-solid fa-check" style="color: var(--success);"></i> ${t('account.copied')}`;
                setTimeout(() => popup.remove(), 800);
            });
            
            // Delete handler
            popup.querySelector('.delete-acc-btn').addEventListener('click', async () => {
                if (confirm(t('account.delete_confirm'))) {
                    popup.remove();
                    await deleteSteamAccount(steamId);
                    loadSteamAccounts();
                }
            });
            
            // Hover effects
            popup.querySelectorAll('button').forEach(b => {
                b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,0.08)'; });
                b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
            });
            
            // Close on outside click
            setTimeout(() => {
                const closeDropdown = (ev) => {
                    if (!popup.contains(ev.target)) {
                        popup.remove();
                        document.removeEventListener('click', closeDropdown);
                    }
                };
                document.addEventListener('click', closeDropdown);
            }, 10);
        });
    });

    // Close dropdowns on outside click (remove old handler to prevent leak)
    if (_dropdownCloseHandler) {
        document.removeEventListener('click', _dropdownCloseHandler);
    }
    _dropdownCloseHandler = () => {
        const existing = document.querySelector('.dropdown-popup');
        if (existing) existing.remove();
    };
    document.addEventListener('click', _dropdownCloseHandler);

    const attachAccountAction = (btn, isLogin) => {
        btn.addEventListener('click', async function() {
            const accountName = this.getAttribute('data-account');
            this.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> ${t('account.switching')}`;
            this.style.pointerEvents = 'none';

            isSwitchingAccount = true;
            snapshotSteamAccountsBeforeSwitch();
            loginUsers = { ...steamAccountsCatalog };
            await renderAccountsGrid(loginUsers);
            await switchSteamAccount(accountName);
            reloadAccountsAfterSwitch();
        });
    };

    document.querySelectorAll('.switch-acc-btn').forEach(btn => attachAccountAction(btn, false));
    document.querySelectorAll('.login-acc-btn').forEach(btn => attachAccountAction(btn, true));
}

async function deleteSteamAccount(steamId) {
    return new Promise((resolve) => {
        delete steamAccountsCatalog[steamId];
        saveSteamAccountsCatalog();

        const vdfPath = path.join(steamPath, 'config', 'loginusers.vdf');
        try {
            if (fs.existsSync(vdfPath)) {
                const backupPath = vdfPath + '.nexus.bak';
                fs.copyFileSync(vdfPath, backupPath);
                const parsedMain = vdf.parse(fs.readFileSync(vdfPath, 'utf-8'));
                const users = parsedMain.users || parsedMain.Users;
                if (users && users[steamId]) {
                    delete users[steamId];
                    parsedMain.users = users;
                    const newContent = vdf.stringify(parsedMain);
                    if (Object.keys(parseLoginUsersFromVdf(newContent)).length >= Object.keys(users).length) {
                        fs.writeFileSync(vdfPath, newContent, 'utf-8');
                    } else {
                        fs.copyFileSync(backupPath, vdfPath);
                    }
                }
            }
        } catch (err) {
            console.error("Failed to delete from loginusers.vdf", err);
        }
        resolve(true);
    });
}

async function switchSteamAccount(accountName, appIdToLaunch = null) {
    if (typeof showToast === 'function') {
        showToast(`${t('toast.account_switched')}: ${accountName}`, 'success', { duration: 3000 });
    }
    return new Promise((resolve) => {
        exec('taskkill /F /IM steam.exe /IM steamwebhelper.exe /T', (error) => {
            setTimeout(() => {
                // Only registry + launch — do NOT rewrite loginusers.vdf (Steam may drop accounts)
                for (const steamId of Object.keys(steamAccountsCatalog)) {
                    if (steamAccountsCatalog[steamId].AccountName === accountName) {
                        steamAccountsCatalog[steamId].MostRecent = '1';
                    } else {
                        steamAccountsCatalog[steamId].MostRecent = '0';
                    }
                }
                saveSteamAccountsCatalog();
                loginUsers = { ...steamAccountsCatalog };
                if (typeof renderAccountsGrid === 'function') {
                    renderAccountsGrid(loginUsers).catch(() => {});
                }

                // Delete StartupModeTmp and Set Registry Keys
                exec(`reg delete "HKCU\\Software\\Valve\\Steam" /v StartupModeTmp /f`, () => {
                    exec(`reg delete "HKCU\\Software\\Valve\\Steam" /v StartupModeTmpIsValid /f`, () => {
                        exec(`reg add "HKCU\\Software\\Valve\\Steam" /v AutoLoginUser /t REG_SZ /d "${accountName}" /f`, () => {
                            exec(`reg add "HKCU\\Software\\Valve\\Steam" /v RememberPassword /t REG_DWORD /d 1 /f`, () => {
                                exec(`reg add "HKCU\\Software\\Valve\\Steam" /v StartupMode /t REG_DWORD /d 0 /f`, () => {
                                    let launchCmd = `start "" "${path.join(steamPath, 'steam.exe')}"`;
                                    if (appIdToLaunch) {
                                        launchCmd = `start "" "${path.join(steamPath, 'steam.exe')}" -applaunch ${appIdToLaunch}`;
                                    }
                                    exec(launchCmd, () => {
                                        resolve(true);
                                    });
                                });
                            });
                        });
                    });
                });
            }, 1500); 
        });
    });
}

async function loadInstalledGames() {
    const grid = document.getElementById('installedGamesGrid');
    if (!grid) return;
    grid.innerHTML = '';
    
    // Pre-build ownership map from userdata + localconfig
    buildGameOwnershipMap();
    
    let allGames = [];
    
    // Steam Games
    if (steamPath) {
        try {
            const libraryFoldersPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
            if (fs.existsSync(libraryFoldersPath)) {
                const libVdf = vdf.parse(fs.readFileSync(libraryFoldersPath, 'utf-8'));
                if (libVdf.libraryfolders) {
                    for (const key in libVdf.libraryfolders) {
                        const lib = libVdf.libraryfolders[key];
                        const appsDir = path.join(lib.path, 'steamapps');
                        if (fs.existsSync(appsDir)) {
                            const files = fs.readdirSync(appsDir);
                            files.forEach(file => {
                                if (file.startsWith('appmanifest_') && file.endsWith('.acf')) {
                                    try {
                                        const acfContent = fs.readFileSync(path.join(appsDir, file), 'utf-8');
                                        const nameMatch = acfContent.match(/"name"\s+"([^"]+)"/i);
                                        const idMatch = acfContent.match(/"appid"\s+"([^"]+)"/i);
                                        const ownerMatch = acfContent.match(/"LastOwner"\s+"([^"]+)"/i);
                                        const ownerId = ownerMatch ? ownerMatch[1] : null;
                                        
                                        if (nameMatch && idMatch && nameMatch[1] !== 'Steamworks Common Redistributables') {
                                            allGames.push({
                                                name: nameMatch[1],
                                                id: idMatch[1],
                                                platform: 'steam',
                                                icon: '<i class="fa-brands fa-steam"></i>',
                                                color: '#1e293b, #000',
                                                ownerId: ownerId
                                            });
                                        }
                                    } catch(e) {}
                                }
                            });
                        }
                    }
                }
            }
        } catch(e) { console.error(e); }
    }
    
    // Epic Games
    try {
        const epicManifests = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
        if (fs.existsSync(epicManifests)) {
            const files = fs.readdirSync(epicManifests);
            files.forEach(file => {
                if (file.endsWith('.item')) {
                    try {
                        const itemData = JSON.parse(fs.readFileSync(path.join(epicManifests, file), 'utf-8'));
                        if (itemData.DisplayName && itemData.AppName) {
                            allGames.push({
                                name: itemData.DisplayName,
                                id: itemData.AppName,
                                platform: 'epic',
                                icon: '<i class="fa-solid fa-e"></i>',
                                color: '#1e293b, #313131'
                            });
                        }
                    } catch(e) {}
                }
            });
        }
    } catch(e) { console.error(e); }

    // Xbox Games
    try {
        const xboxDir = 'C:\\XboxGames';
        if (fs.existsSync(xboxDir)) {
            const folders = fs.readdirSync(xboxDir);
            folders.forEach(folder => {
                const lower = folder.toLowerCase();
                if (lower.includes('dlc') || lower.includes('stub') || lower.includes('gamesave') || lower.includes('pack') || lower.includes('tracker')) return;
                
                const gameDir = path.join(xboxDir, folder);
                if (fs.statSync(gameDir).isDirectory()) {
                    let exePath = path.join(gameDir, 'Content', 'gamelaunchhelper.exe');
                    if (!fs.existsSync(exePath)) exePath = path.join(gameDir, 'gamelaunchhelper.exe');
                    
                    if (fs.existsSync(exePath)) {
                        allGames.push({
                            name: folder,
                            id: folder,
                            platform: 'xbox',
                            icon: '<i class="fa-brands fa-xbox" style="color: #107c10; font-size: 2.5rem;"></i>',
                            color: '#1e293b, #107c10',
                            exe: exePath
                        });
                    }
                }
            });
        }
    } catch(e) { console.error("Error reading Xbox games", e); }

    // 4. Battle.net Games (Heuristic Scan)
    try {
        const bnetFolders = ['C:\\Program Files (x86)', 'C:\\Program Files'];
        const bnetGames = [
            { folder: 'Call of Duty', exe: 'Call of Duty Launcher.exe' },
            { folder: 'Overwatch', exe: 'Overwatch Launcher.exe' },
            { folder: 'World of Warcraft', exe: 'World of Warcraft Launcher.exe' },
            { folder: 'Diablo IV', exe: 'Diablo IV Launcher.exe' },
            { folder: 'Hearthstone', exe: 'Hearthstone.exe' }
        ];

        bnetFolders.forEach(baseDir => {
            if (!fs.existsSync(baseDir)) return;
            bnetGames.forEach(g => {
                const gamePath = path.join(baseDir, g.folder);
                const exePath = path.join(gamePath, g.exe);
                if (fs.existsSync(exePath)) {
                    allGames.push({
                        id: g.folder,
                        name: g.folder,
                        platform: 'battlenet',
                        exe: exePath,
                        icon: '<i class="fa-brands fa-battle-net" style="color: #00a4e4; font-size: 2.5rem;"></i>'
                    });
                }
            });
        });
    } catch(e) { console.error("Error reading Battle.net games", e); }

    // 5. EA App Games (Heuristic Scan)
    try {
        const eaDir = 'C:\\Program Files\\EA Games';
        if (fs.existsSync(eaDir)) {
            const folders = fs.readdirSync(eaDir);
            for (let folder of folders) {
                const gamePath = path.join(eaDir, folder);
                if (fs.statSync(gamePath).isDirectory()) {
                    // Find largest .exe in the root of game folder
                    const files = fs.readdirSync(gamePath).filter(f => f.toLowerCase().endsWith('.exe') && !f.toLowerCase().includes('cleanup') && !f.toLowerCase().includes('touchup'));
                    if (files.length > 0) {
                        const exePath = path.join(gamePath, files[0]);
                        allGames.push({
                            id: folder,
                            name: folder,
                            platform: 'ea',
                            exe: exePath,
                            icon: '<strong style="color: #ff4747; font-size: 2rem;">EA</strong>'
                        });
                    }
                }
            }
        }
    } catch(e) { console.error("Error reading EA games", e); }

    allGames.sort((a, b) => a.name.localeCompare(b.name));

    grid.innerHTML = '';
    if (allGames.length === 0) {
        grid.innerHTML = '<div class="info-box"><p>لم يتم العثور على ألعاب مثبتة.</p></div>';
        return;
    }
    
    allGames.forEach(game => {
        const card = document.createElement('div');
        card.className = 'account-card';
        
        let bannerHtml = `
            <div class="profile-pic placeholder-pic" style="position: relative; width: 100%; height: 120px; border-radius: 12px; margin-bottom: 1rem; background: rgba(0,0,0,0.3); border: none;">
                ${game.icon}
                <button class="btn-icon change-cover-btn" data-game="${game.id || game.name}" style="position: absolute; top: 8px; right: 8px; width: 32px; height: 32px; background: rgba(0,0,0,0.6); border: none; z-index: 10; opacity: 0; transition: opacity 0.2s;" title="تغيير الغلاف">
                    <i class="fa-solid fa-image" style="font-size: 1rem;"></i>
                </button>
            </div>
        `;
        
        let coverUrl = null;
        if (customCovers[game.id || game.name]) {
            coverUrl = `file://${customCovers[game.id || game.name].replace(/\\/g, '/')}`;
        } else if (game.platform === 'steam') {
            coverUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${game.id}/header.jpg`;
        }

        if (coverUrl) {
            bannerHtml = `
                <div style="position: relative; width: 100%; height: 120px; margin-bottom: 1rem;">
                    <img src="${coverUrl}" 
                         style="width: 100%; height: 100%; object-fit: cover; border-radius: 12px; border: 1px solid var(--border);"
                         onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                    <div class="profile-pic placeholder-pic fallback-banner" style="display: none; width: 100%; height: 100%; border-radius: 12px; background: rgba(0,0,0,0.3); border: none; position: absolute; top: 0; left: 0; justify-content: center; align-items: center;">
                        ${game.icon}
                    </div>
                    <button class="btn-icon change-cover-btn" data-game="${game.id || game.name}" style="position: absolute; top: 8px; right: 8px; width: 32px; height: 32px; background: rgba(0,0,0,0.6); border: none; z-index: 10; opacity: 0; transition: opacity 0.2s;" title="تغيير الغلاف">
                        <i class="fa-solid fa-image" style="font-size: 1rem;"></i>
                    </button>
                </div>
            `;
        }

        // Determine linked account display for Steam games
        let accountBadgeHtml = '';
        let assignBtnHtml = '';
        if (game.platform === 'steam') {
            const linkedAccount = resolveGameAccount(game.id, game.ownerId);
            if (linkedAccount) {
                accountBadgeHtml = `<span class="game-account-badge" style="font-size: 0.75rem; background: rgba(96,205,255,0.15); color: var(--primary); padding: 0.2rem 0.5rem; border-radius: 6px; display: inline-flex; align-items: center; gap: 0.3rem;"><i class="fa-solid fa-user"></i> ${linkedAccount}</span>`;
            } else {
                accountBadgeHtml = `<span class="game-account-badge" style="font-size: 0.75rem; background: rgba(239,68,68,0.1); color: var(--danger); padding: 0.2rem 0.5rem; border-radius: 6px; display: inline-flex; align-items: center; gap: 0.3rem;"><i class="fa-solid fa-circle-question"></i> ${t('game.unknown_owner')}</span>`;
            }
            assignBtnHtml = `<button class="btn-icon assign-account-btn" data-game-id="${game.id}" data-game-name="${game.name}" title="${t('game.assign_account')}" style="position: absolute; top: 8px; left: 8px; width: 30px; height: 30px; background: rgba(0,0,0,0.7); border: none; z-index: 10; opacity: 0; transition: opacity 0.2s; font-size: 0.85rem;"><i class="fa-solid fa-user-pen"></i></button>`;
        }
        
        // Playtime badge
        let playtimeHtml = '';
        const pt = playtimeData[game.id];
        if (pt && pt.totalSeconds > 0) {
            const formatted = formatPlaytime(pt.totalSeconds);
            const lastP = formatLastPlayed(pt.lastPlayed);
            playtimeHtml = `<span class="game-playtime-badge" title="${t('game.last_played')}: ${lastP || ''}" style="font-size: 0.7rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: 0.25rem; margin-top: 0.25rem;"><i class="fa-solid fa-clock"></i> ${formatted}</span>`;
        }

        card.innerHTML = `
            <div class="card-glow"></div>
            ${bannerHtml}
            ${assignBtnHtml}
            <div class="card-body">
                <h3 style="font-size: 1.1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${game.name}">${game.name}</h3>
                <p class="steam-id" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">${getPlatformName(game.platform)} ${accountBadgeHtml}</p>
                ${playtimeHtml}
            </div>
            <div class="card-actions" style="display: flex; gap: 0.4rem;">
                <button class="btn btn-switch launch-game-btn" data-platform="${game.platform}" data-id="${game.id}" data-exe="${game.exe || ''}" data-owner="${game.ownerId || ''}" style="flex: 1;">
                    <i class="fa-solid fa-play"></i> ${t('game.launch')}
                </button>
                <button class="btn-icon game-info-btn" data-game-id="${game.id}" data-game-name="${game.name}" data-platform="${game.platform}" title="${t('gameinfo.title')}" style="width: 36px; height: 36px;">
                    <i class="fa-solid fa-circle-info"></i>
                </button>
            </div>
        `;
        grid.appendChild(card);
    });
    
    // Wire game info buttons
    document.querySelectorAll('.game-info-btn').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const gameId = this.getAttribute('data-game-id');
            const gameName = this.getAttribute('data-game-name');
            const platform = this.getAttribute('data-platform');
            openGameInfoModal(gameId, gameName, platform);
        });
    });
    
    document.querySelectorAll('.change-cover-btn').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const gameId = this.getAttribute('data-game');
            const fileInput = document.getElementById('coverUploadInput');
            if (fileInput) {
                fileInput.onchange = function(evt) {
                    const file = evt.target.files[0];
                    if (file) {
                        customCovers[gameId] = file.path;
                        try {
                            saveCustomCovers();
                        } catch(err) { console.error("Error saving custom cover", err); }
                        loadInstalledGames(); // Reload to show new cover
                    }
                    fileInput.value = ''; // Reset input
                };
                fileInput.click();
            }
        });
    });
    
    // Account assignment button handler
    document.querySelectorAll('.assign-account-btn').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const gameId = this.getAttribute('data-game-id');
            const gameName = this.getAttribute('data-game-name');
            
            // Remove any existing assignment popup
            const existingPopup = document.querySelector('.assign-popup');
            if (existingPopup) existingPopup.remove();
            
            // Build account options from loginUsers
            const accounts = Object.keys(loginUsers).map(steamId => ({
                steamId,
                name: loginUsers[steamId].AccountName,
                persona: loginUsers[steamId].PersonaName || loginUsers[steamId].AccountName
            }));
            
            if (accounts.length === 0) return;
            
            // Create popup
            const popup = document.createElement('div');
            popup.className = 'assign-popup';
            
            let popupHtml = `<p style="font-size: 0.8rem; color: var(--text-muted); padding: 0.5rem 0.8rem; border-bottom: 1px solid var(--border); margin-bottom: 0.3rem; white-space: nowrap;">تعيين حساب لـ <strong style="color: var(--text-main);">${gameName}</strong></p>`;
            
            accounts.forEach(acc => {
                const isLinked = gameAccounts[gameId] === acc.name;
                popupHtml += `
                    <button class="assign-acc-option" data-game-id="${gameId}" data-account="${acc.name}" style="width: 100%; display: flex; flex-direction: row-reverse; align-items: center; gap: 0.6rem; padding: 0.6rem 0.8rem; background: ${isLinked ? 'rgba(59,130,246,0.15)' : 'transparent'}; border: none; border-radius: 8px; color: ${isLinked ? 'var(--primary)' : 'var(--text-main)'}; cursor: pointer; font-size: 0.85rem; font-family: inherit; transition: background 0.2s; justify-content: flex-end;">
                        <i class="fa-solid ${isLinked ? 'fa-circle-check' : 'fa-user'}" style="color: ${isLinked ? 'var(--primary)' : 'var(--text-muted)'};"></i>
                        <div style="display: flex; flex-direction: column; align-items: flex-end;">
                            <span>${acc.persona}</span>
                            <span style="color: var(--text-muted); font-size: 0.7rem; direction: ltr;">${acc.name}</span>
                        </div>
                    </button>
                `;
            });
            
            // Add "remove assignment" option if already mapped
            if (gameAccounts[gameId]) {
                popupHtml += `<hr style="border: 0; border-top: 1px solid var(--border); margin: 0.3rem 0;">`;
                popupHtml += `
                    <button class="assign-acc-option" data-game-id="${gameId}" data-account="" style="width: 100%; display: flex; flex-direction: row-reverse; align-items: center; gap: 0.5rem; padding: 0.6rem 0.8rem; background: transparent; border: none; border-radius: 8px; color: var(--danger); cursor: pointer; font-size: 0.85rem; font-family: inherit; justify-content: flex-end;">
                        <i class="fa-solid fa-xmark"></i> إزالة التعيين
                    </button>
                `;
            }
            
            popup.innerHTML = popupHtml;
            
            // Append to body to avoid overflow:hidden clipping in list view
            document.body.appendChild(popup);
            const btnRect = this.getBoundingClientRect();
            popup.style.cssText = `position: fixed; top: ${btnRect.bottom + 6}px; left: ${btnRect.left}px; background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 12px; padding: 0.5rem; z-index: 999; box-shadow: 0 10px 30px rgba(0,0,0,0.5); min-width: 220px; direction: rtl;`;
            
            // Keep popup in viewport
            requestAnimationFrame(() => {
                const popupRect = popup.getBoundingClientRect();
                if (popupRect.bottom > window.innerHeight) {
                    popup.style.top = `${btnRect.top - popupRect.height - 6}px`;
                }
                if (popupRect.left < 0) {
                    popup.style.left = '8px';
                }
            });
            
            // Handle selection
            popup.querySelectorAll('.assign-acc-option').forEach(opt => {
                opt.addEventListener('mouseenter', () => { opt.style.background = 'rgba(255,255,255,0.08)'; });
                opt.addEventListener('mouseleave', () => { opt.style.background = 'transparent'; });
                opt.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const selectedAccount = opt.getAttribute('data-account');
                    const gId = opt.getAttribute('data-game-id');
                    
                    if (selectedAccount) {
                        gameAccounts[gId] = selectedAccount;
                    } else {
                        delete gameAccounts[gId];
                    }
                    saveGameAccounts();
                    popup.remove();
                    loadInstalledGames();
                });
            });
            
            // Close popup on outside click
            setTimeout(() => {
                const closePopup = (ev) => {
                    if (!popup.contains(ev.target)) {
                        popup.remove();
                        document.removeEventListener('click', closePopup);
                    }
                };
                document.addEventListener('click', closePopup);
            }, 10);
        });
    });

    document.querySelectorAll('.launch-game-btn').forEach(btn => {
        btn.addEventListener('click', async function() {
            const platform = this.getAttribute('data-platform');
            const id = this.getAttribute('data-id');
            const exe = this.getAttribute('data-exe');
            const ownerId = this.getAttribute('data-owner');
            const gameName = this.closest('.account-card')?.querySelector('h3')?.innerText || id;
            
            this.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t('game.launching')}`;
            this.style.pointerEvents = 'none';
            
            if (isGameBoosterEnabled) {
                this.innerHTML = `<i class="fa-solid fa-rocket fa-spin" style="color: var(--success);"></i> ${t('game.boosting')}`;
                const boostResult = await runGameBoost();
                showBoostStats(boostResult.freed, boostResult.killed);
            }
            
            if (platform === 'steam') {
                try {
                    // Use improved account resolution (manual mapping > LastOwner > userdata)
                    const targetAccountName = resolveGameAccount(id, ownerId);
                    
                    if (targetAccountName) {
                        // Check actual current account via registry (not MostRecent flag)
                        const currentAccount = await getCurrentSteamAccount();
                        
                        if (currentAccount && currentAccount.toLowerCase() !== targetAccountName.toLowerCase()) {
                            this.innerHTML = `<i class="fa-solid fa-bolt fa-spin"></i> ${t('game.switching_account')}`;
                            await switchSteamAccount(targetAccountName, id);
                            startGameSession(id, gameName, exe);
                            setTimeout(() => {
                                this.innerHTML = `<i class="fa-solid fa-play"></i> ${t('game.launch')}`;
                                this.style.pointerEvents = 'all';
                            }, 3000);
                            return;
                        }
                    }
                } catch(err) { console.error("Auto switch failed", err); }
                
                exec(`start steam://rungameid/${id}`);
                startGameSession(id, gameName, exe);
            } else if (platform === 'epic') {
                exec(`start com.epicgames.launcher://apps/${id}?action=launch&silent=true`);
                startGameSession(id, gameName, exe);
            } else {
                if (exe) {
                    exec(`start "" "${exe}"`);
                    startGameSession(id, gameName, exe);
                }
            }
            
            setTimeout(() => {
                this.innerHTML = `<i class="fa-solid fa-play"></i> ${t('game.launch')}`;
                this.style.pointerEvents = 'all';
            }, 2000);
        });
    });
}

function getPlatformName(platform) {
    switch(platform) {
        case 'steam': return 'ستيم';
        case 'epic': return 'إيبيك قيمز';
        case 'xbox': return 'إكس بوكس';
        case 'battlenet': return 'باتل نت';
        case 'ea': return 'إي أيه أب';
        default: return platform;
    }
}

// Steam Status Checker
function checkSteamStatus() {
    exec('tasklist /FI "IMAGENAME eq steam.exe" /NH', (err, stdout) => {
        const isRunning = stdout && stdout.toLowerCase().includes('steam.exe');
        const statusDot = document.getElementById('steamStatusDot');
        const statusText = document.getElementById('steamStatusText');
        const container = document.getElementById('steamStatusContainer');
        
        if (statusDot && statusText && container) {
            if (isRunning) {
                statusDot.style.background = 'var(--success)';
                statusDot.style.boxShadow = '0 0 10px var(--success)';
                statusText.innerText = t('steam.steam_online');
                container.style.borderColor = 'rgba(16, 185, 129, 0.2)';
            } else {
                statusDot.style.background = 'var(--danger)';
                statusDot.style.boxShadow = '0 0 10px var(--danger)';
                statusText.innerText = t('steam.steam_offline');
                container.style.borderColor = 'rgba(239, 68, 68, 0.2)';
            }
        }
    });
}

setInterval(checkSteamStatus, 3000);
checkSteamStatus();

// ===========================================
// ===== Account Notes Modal =====
// ===========================================
function openNotesModal(steamId, personaName) {
    const existing = document.getElementById('notesModalOverlay');
    if (existing) existing.remove();
    
    const currentNote = accountNotes[steamId] || '';
    const overlay = document.createElement('div');
    overlay.id = 'notesModalOverlay';
    overlay.className = 'modal-overlay active';
    overlay.innerHTML = `
        <div class="modal" style="max-width: 480px;">
            <h2 style="display: flex; align-items: center; gap: 0.5rem;">
                <i class="fa-solid fa-note-sticky" style="color: var(--primary);"></i>
                ${t('account.notes')} - ${personaName}
            </h2>
            <div class="form-group">
                <textarea id="notesTextarea" placeholder="${t('account.notes_placeholder')}" style="width: 100%; min-height: 140px; padding: 0.75rem; background: var(--bg-elevated); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); color: var(--text-main); font-family: inherit; font-size: 0.9rem; resize: vertical; line-height: 1.5;">${currentNote}</textarea>
            </div>
            <div class="modal-actions">
                <button class="btn" id="notesCancel">${t('modal.close')}</button>
                <button class="btn btn-primary" id="notesSave">${t('account.save_notes')}</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    
    const textarea = overlay.querySelector('#notesTextarea');
    setTimeout(() => textarea.focus(), 100);
    
    overlay.querySelector('#notesCancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#notesSave').addEventListener('click', () => {
        const note = textarea.value.trim();
        if (note) {
            accountNotes[steamId] = note;
        } else {
            delete accountNotes[steamId];
        }
        saveAccountNotes();
        overlay.remove();
        showToast(t('toast.notes_saved'), 'success');
        loadSteamAccounts(); // refresh to update notes badge
    });
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
}

// ===========================================
// ===== Performance Monitor =====
// ===========================================
let performanceMonitorInterval = null;

async function updatePerformanceUI() {
    const stats = await ipcRenderer.invoke('get-system-stats');
    const gpu = await ipcRenderer.invoke('get-gpu-stats');
    
    const cpuBar = document.getElementById('perfCpuBar');
    const cpuText = document.getElementById('perfCpuText');
    const cpuModel = document.getElementById('perfCpuModel');
    if (cpuBar && cpuText) {
        cpuBar.style.width = stats.cpu.usage + '%';
        cpuText.innerText = stats.cpu.usage + '%';
        cpuBar.style.background = stats.cpu.usage > 80 ? 'var(--danger)' : stats.cpu.usage > 60 ? 'var(--warning)' : 'var(--primary)';
    }
    if (cpuModel) cpuModel.innerText = `${stats.cpu.model} • ${stats.cpu.cores} ${t('performance.cores')}`;
    
    const ramBar = document.getElementById('perfRamBar');
    const ramText = document.getElementById('perfRamText');
    if (ramBar && ramText) {
        ramBar.style.width = stats.ram.usagePercent + '%';
        ramText.innerText = `${stats.ram.usedGB} / ${stats.ram.totalGB} GB (${stats.ram.usagePercent}%)`;
        ramBar.style.background = stats.ram.usagePercent > 85 ? 'var(--danger)' : stats.ram.usagePercent > 70 ? 'var(--warning)' : 'var(--primary)';
    }
    
    const gpuBar = document.getElementById('perfGpuBar');
    const gpuText = document.getElementById('perfGpuText');
    const gpuName = document.getElementById('perfGpuName');
    const gpuTemp = document.getElementById('perfGpuTemp');
    const vramText = document.getElementById('vramUsageText');
    const vramBar = document.getElementById('vramBar');

    if (gpu.available && gpuBar) {
        gpuBar.style.width = gpu.usage + '%';
        gpuText.innerText = gpu.usage + '%';
        gpuBar.style.background = gpu.usage > 80 ? 'var(--danger)' : gpu.usage > 60 ? 'var(--warning)' : 'var(--primary)';
        if (gpuName) gpuName.innerText = gpu.name || 'GPU';
        if (gpuTemp && gpu.temp) gpuTemp.innerText = `🌡 ${gpu.temp}°C`;
        
        // Update VRAM
        if (vramText && vramBar && gpu.memTotal > 0) {
            const used = gpu.memUsed || 0;
            const total = gpu.memTotal;
            const percent = Math.round((used / total) * 100);
            vramText.innerText = `${used} / ${total} MB (${percent}%)`;
            vramBar.style.width = `${percent}%`;
            if (percent > 85) vramBar.style.background = 'var(--danger)';
            else if (percent > 70) vramBar.style.background = 'var(--warning)';
            else vramBar.style.background = 'var(--primary)';
        }
    } else if (gpuText) {
        gpuText.innerText = t('performance.no_gpu');
        if (gpuBar) gpuBar.style.width = '0%';
        if (vramText) vramText.innerText = currentLang === 'ar' ? 'غير متاح' : 'Unavailable';
        if (vramBar) vramBar.style.width = '0%';
    }
    
    const uptimeEl = document.getElementById('perfUptime');
    if (uptimeEl) {
        const h = Math.floor(stats.uptime / 3600);
        const m = Math.floor((stats.uptime % 3600) / 60);
        uptimeEl.innerText = `${h}h ${m}m`;
    }
}

function startPerformanceMonitor() {
    if (performanceMonitorInterval) return;
    updatePerformanceUI();
    performanceMonitorInterval = setInterval(updatePerformanceUI, 2000);
}

function stopPerformanceMonitor() {
    if (performanceMonitorInterval) {
        clearInterval(performanceMonitorInterval);
        performanceMonitorInterval = null;
    }
}

// ===========================================
// ===== Free Games Tracker =====
// ===========================================
let cachedFreeGames = null;
let lastFreeGamesCheck = 0;

async function fetchFreeGames(force = false) {
    const listEl = document.getElementById('freeGamesList');
    if (!listEl) return;

    const now = Date.now();
    // Cache for 30 minutes to avoid hitting API limits
    if (!force && cachedFreeGames && (now - lastFreeGamesCheck) < 1800000) {
        renderFreeGames(cachedFreeGames);
        return;
    }

    listEl.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem;"><i class="fa-solid fa-spinner fa-spin"></i> ${t('common.loading')}</div>`;
    
    try {
        const https = require('https');
        const data = await new Promise((resolve, reject) => {
            https.get('https://www.gamerpower.com/api/giveaways?platform=pc', (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`API Error: ${res.statusCode}`));
                    return;
                }
                let rawData = '';
                res.on('data', (chunk) => rawData += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(rawData)); }
                    catch(e) { reject(e); }
                });
            }).on('error', reject);
        });
        
        // Filter locally to get only Games from Steam, Epic, GOG
        const filteredGames = data.filter(game => 
            game.type === 'Game' && 
            (game.platforms.toLowerCase().includes('steam') || 
             game.platforms.toLowerCase().includes('epic') || 
             game.platforms.toLowerCase().includes('gog'))
        );
        
        cachedFreeGames = filteredGames.slice(0, 10); // get top 10
        lastFreeGamesCheck = now;
        renderFreeGames(cachedFreeGames);
    } catch (e) {
        console.error("Free games error:", e);
        listEl.innerHTML = `<div style="color: var(--danger); font-size: 0.85rem;"><i class="fa-solid fa-circle-exclamation"></i> ${currentLang === 'ar' ? 'تعذر جلب الألعاب المجانية' : 'Could not fetch free games'}</div>`;
    }
}

function renderFreeGames(games) {
    const listEl = document.getElementById('freeGamesList');
    if (!listEl) return;
    
    listEl.innerHTML = '';
    
    if (!games || games.length === 0) {
        listEl.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem;">${currentLang === 'ar' ? 'لا توجد عروض حالياً' : 'No giveaways available'}</div>`;
        return;
    }

    games.forEach(game => {
        let platIcon = 'fa-windows';
        const p = game.platforms.toLowerCase();
        if (p.includes('steam')) platIcon = 'fa-steam';
        else if (p.includes('epic')) platIcon = 'fa-e';
        else if (p.includes('gog')) platIcon = 'fa-g';
        
        const card = document.createElement('div');
        card.className = 'free-game-card';
        card.innerHTML = `
            <img src="${game.thumbnail}" alt="${game.title}" onerror="this.src='https://via.placeholder.com/180x100/1e1e1e/888888?text=No+Image'">
            <div class="info">
                <div class="title" title="${game.title}">${game.title}</div>
                <div class="platform">
                    <span><i class="fa-brands ${platIcon}"></i> ${game.platforms.split(',')[0]}</span>
                    <span class="badge">FREE</span>
                </div>
            </div>
        `;
        card.addEventListener('click', () => {
            ipcRenderer.invoke('open-external', game.open_giveaway);
        });
        
        listEl.appendChild(card);
    });
}

// ===========================================
// ===== Backup / Import / Export =====
// ===========================================
async function exportFullBackup() {
    const status = document.getElementById('backupStatus');
    if (status) status.innerText = t('backup.backing_up');
    
    const result = await ipcRenderer.invoke('export-backup');
    if (!result.success) {
        if (status && !result.canceled) status.innerText = t('backup.error');
        return;
    }
    
    try {
        const backup = {
            version: '1.0',
            timestamp: new Date().toISOString(),
            data: {
                gameAccounts,
                accountNotes,
                playtimeData,
                customCovers,
                settings: {
                    lang: currentLang,
                    encryption: localStorage.getItem('nexus_encryption') === 'true',
                    booster: localStorage.getItem('nexus_game_booster') === 'true',
                    boosterProcesses: boosterProcesses,
                    viewMode: localStorage.getItem('nexus_view_mode') || 'grid',
                    themeColor: localStorage.getItem('nexus_theme_color') || ''
                }
            }
        };
        fs.writeFileSync(result.filePath, JSON.stringify(backup, null, 2), 'utf-8');
        if (status) {
            status.innerHTML = `<span style="color: var(--success);"><i class="fa-solid fa-circle-check"></i> ${t('backup.success')}</span>`;
        }
        showToast(t('toast.backup_success'), 'success', { title: t('backup.title') });
    } catch(e) {
        console.error(e);
        if (status) status.innerText = t('backup.error');
        showToast(t('toast.backup_failed'), 'error');
    }
}

async function importFullBackup() {
    const status = document.getElementById('backupStatus');
    const result = await ipcRenderer.invoke('import-backup');
    if (!result.success) return;
    
    if (status) status.innerText = t('backup.restoring');
    
    try {
        const content = fs.readFileSync(result.filePath, 'utf-8');
        const backup = JSON.parse(content);
        if (!backup.data) throw new Error('Invalid backup format');
        
        const d = backup.data;
        if (d.gameAccounts) { gameAccounts = d.gameAccounts; saveGameAccounts(); }
        if (d.accountNotes) { accountNotes = d.accountNotes; saveAccountNotes(); }
        if (d.playtimeData) { playtimeData = d.playtimeData; savePlaytime(); }
        if (d.customCovers) {
            customCovers = d.customCovers;
            saveCustomCovers();
        }
        if (d.settings) {
            if (d.settings.lang) localStorage.setItem('nexus_lang', d.settings.lang);
            if (typeof d.settings.encryption === 'boolean') localStorage.setItem('nexus_encryption', d.settings.encryption);
            if (typeof d.settings.booster === 'boolean') localStorage.setItem('nexus_game_booster', d.settings.booster);
            if (d.settings.boosterProcesses) {
                boosterProcesses = d.settings.boosterProcesses;
                localStorage.setItem('nexus_booster_processes', JSON.stringify(boosterProcesses));
            }
            if (d.settings.viewMode) localStorage.setItem('nexus_view_mode', d.settings.viewMode);
            if (d.settings.themeColor) localStorage.setItem('nexus_theme_color', d.settings.themeColor);
        }
        
        if (status) status.innerHTML = `<span style="color: var(--success);"><i class="fa-solid fa-circle-check"></i> ${t('backup.success')}</span>`;
        showToast(t('toast.restore_success'), 'success');
        setTimeout(() => location.reload(), 1500);
    } catch(e) {
        console.error(e);
        if (status) status.innerText = t('backup.error');
        showToast(t('backup.error'), 'error');
    }
}

// ===========================================
// ===== Auto Update Checker =====
// ===========================================
async function checkForUpdatesAuto() {
    try {
        const res = await ipcRenderer.invoke('check-updates');
        if (res.success && res.hasUpdate) {
            const isAr = currentLang === 'ar';
            const msg = isAr
                ? `يتوفر تحديث جديد! v${res.latest} (${isAr ? 'الإصدار الحالي' : 'current'}: v${res.current})`
                : `New update available! v${res.latest} (current: v${res.current})`;
            showToast(msg, 'info', {
                title: t('toast.update_available'),
                duration: 8000,
                icon: 'fa-solid fa-arrow-up'
            });
        }
    } catch (e) {
        // Silent fail - don't bother user on startup if network is down
    }
}

// ===========================================
// ===== Settings UI Wiring (after DOM ready) =====
// ===========================================
window.addEventListener('DOMContentLoaded', async () => {
    await appInitPromise;
    // Apply current language
    document.documentElement.setAttribute('lang', currentLang);
    document.documentElement.setAttribute('dir', currentLang === 'ar' ? 'rtl' : 'ltr');
    setTimeout(applyTranslations, 100);

    // Auto-check for updates on startup (silent, only shows toast if update found)
    setTimeout(checkForUpdatesAuto, 3000);
    
    // Language switcher
    const langButtons = document.querySelectorAll('[data-lang]');
    langButtons.forEach(btn => {
        if (btn.getAttribute('data-lang') === currentLang) btn.classList.add('active');
        btn.addEventListener('click', () => {
            const lang = btn.getAttribute('data-lang');
            if (lang === currentLang) return;
            setLanguage(lang);
            langButtons.forEach(b => b.classList.toggle('active', b.getAttribute('data-lang') === lang));
            showToast(t('toast.language_changed'), 'info');
            // Refresh dynamic content
            setTimeout(() => {
                if (typeof loadSteamAccounts === 'function') loadSteamAccounts();
                if (typeof loadInstalledGames === 'function') loadInstalledGames();
            }, 100);
        });
    });
    
    // Encryption toggle
    const encToggle = document.getElementById('toggleEncryption');
    if (encToggle) {
        const isEnc = localStorage.getItem('nexus_encryption') === 'true';
        updateToggleButton(encToggle, isEnc);
        encToggle.addEventListener('click', async () => {
            const available = await ipcRenderer.invoke('encryption-available');
            if (!available) {
                showToast(t('settings.encryption_unavailable'), 'warning');
                return;
            }
            const newState = !(localStorage.getItem('nexus_encryption') === 'true');
            localStorage.setItem('nexus_encryption', newState);
            updateToggleButton(encToggle, newState);
            // Re-save all encrypted files with new setting
            saveGameAccounts();
            saveAccountNotes();
            savePlaytime();
            saveCustomCovers();
            showToast(newState ? t('toast.encryption_enabled') : t('toast.encryption_disabled'), newState ? 'success' : 'info');
        });
    }
    

    
    // Performance monitor nav: start when shown, stop when hidden
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const target = item.getAttribute('data-target');
            if (target === 'performance') {
                setTimeout(() => {
                    startPerformanceMonitor();
                    renderServerStatusWidget();
                }, 100);
            } else {
                stopPerformanceMonitor();
            }
            if (target === 'games') {
                setTimeout(() => fetchFreeGames(), 100);
            }
        });
    });
    
    // Refresh free games button
    const refreshFreeGamesBtn = document.getElementById('refreshFreeGamesBtn');
    if (refreshFreeGamesBtn) {
        refreshFreeGamesBtn.addEventListener('click', () => fetchFreeGames(true));
    }
    
    // Server status refresh button
    const refreshServerBtn = document.getElementById('refreshServerStatusBtn');
    if (refreshServerBtn) {
        refreshServerBtn.addEventListener('click', () => renderServerStatusWidget());
    }
    
    // Backup/Restore buttons
    const exportBtn = document.getElementById('btnExportBackup');
    if (exportBtn) exportBtn.addEventListener('click', exportFullBackup);
    
    const importBtn = document.getElementById('btnImportBackup');
    if (importBtn) importBtn.addEventListener('click', importFullBackup);
    
    // Show app version (sidebar + About section)
    ipcRenderer.invoke('app-version').then(v => {
        const verEl = document.getElementById('appVersionDisplay');
        if (verEl) verEl.innerText = `v${v}`;
        const verEl2 = document.getElementById('appVersionDisplay2');
        if (verEl2) verEl2.innerText = `v${v}`;
    });
    
    // VRAM Optimizer
    initVramOptimizer();
});

// ===========================================
// ===== VRAM Optimizer =====
// ===========================================

function initVramOptimizer() {
    const clearBtn = document.getElementById('clearShaderCacheBtn');
    const restartBtn = document.getElementById('restartGpuDriverBtn');
    const freedStats = document.getElementById('vramFreedStats');
    const freedText = document.getElementById('vramFreedText');
    
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            if (!confirm(t('vram.confirm_cache'))) return;
            
            const orig = clearBtn.innerHTML;
            clearBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>${t('vram.clearing')}</span>`;
            clearBtn.disabled = true;
            
            try {
                const result = await ipcRenderer.invoke('clear-shader-cache');
                if (result.success) {
                    const mb = parseFloat(result.freedMB);
                    if (mb > 0 && freedStats && freedText) {
                        freedText.innerText = `${t('vram.freed')} ${result.freedMB} MB (${result.cleanedCount} ${currentLang === 'ar' ? 'مجلد' : 'folders'})`;
                        freedStats.style.display = 'block';
                        setTimeout(() => { freedStats.style.display = 'none'; }, 8000);
                    }
                    showToast(
                        mb > 0 ? `${t('vram.freed')} ${result.freedMB} MB` : t('vram.no_files'),
                        mb > 0 ? 'success' : 'info',
                        { title: t('vram.cleared') }
                    );
                    updatePerformanceUI(); // refresh
                } else {
                    showToast(result.error || 'unknown', 'error', { title: t('common.error') });
                }
            } catch (e) {
                showToast(e.message, 'error', { title: t('common.error') });
            } finally {
                clearBtn.innerHTML = orig;
                clearBtn.disabled = false;
            }
        });
    }
    
    if (restartBtn) {
        restartBtn.addEventListener('click', async () => {
            if (!confirm(t('vram.confirm_driver'))) return;
            
            const orig = restartBtn.innerHTML;
            restartBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>${t('vram.restarting')}</span>`;
            restartBtn.disabled = true;
            
            try {
                const result = await ipcRenderer.invoke('restart-gpu-driver');
                if (result.success) {
                    showToast(
                        currentLang === 'ar' ? 'تم تفريغ VRAM' : 'VRAM cleared',
                        'success',
                        { title: t('vram.driver_restarted') }
                    );
                    setTimeout(updatePerformanceUI, 2000); // refresh
                } else {
                    showToast(result.error || 'unknown', 'error', { title: t('common.error') });
                }
            } catch (e) {
                showToast(e.message, 'error', { title: t('common.error') });
            } finally {
                restartBtn.innerHTML = orig;
                restartBtn.disabled = false;
            }
        });
    }
}

function updateToggleButton(btn, isEnabled) {
    if (isEnabled) {
        btn.innerHTML = `<i class="fa-solid fa-toggle-on"></i> <span>${t('settings.enabled')}</span>`;
        btn.classList.add('active-acc-btn');
    } else {
        btn.innerHTML = `<i class="fa-solid fa-toggle-off"></i> <span>${t('settings.disabled')}</span>`;
        btn.classList.remove('active-acc-btn');
    }
}

// ===========================================
// ===== Toast Notification System =====
// ===========================================
function showToast(message, type = 'info', options = {}) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    
    const { title = '', duration = 3500, icon = null } = options;
    const iconMap = {
        success: 'fa-circle-check',
        error: 'fa-circle-exclamation',
        warning: 'fa-triangle-exclamation',
        info: 'fa-circle-info'
    };
    const iconClass = icon || iconMap[type] || iconMap.info;
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <div class="toast-icon"><i class="fa-solid ${iconClass}"></i></div>
        <div class="toast-content">
            ${title ? `<div class="toast-title">${title}</div>` : ''}
            <div class="toast-message">${message}</div>
        </div>
        <button class="toast-close" aria-label="close"><i class="fa-solid fa-xmark"></i></button>
    `;
    container.appendChild(toast);
    
    const closeBtn = toast.querySelector('.toast-close');
    const removeToast = () => {
        toast.classList.add('toast-hide');
        setTimeout(() => toast.remove(), 250);
    };
    closeBtn.addEventListener('click', removeToast);
    
    if (duration > 0) {
        setTimeout(removeToast, duration);
    }
    
    return toast;
}

// Expose to window for easy debugging
window.showToast = showToast;

// ===========================================
// ===== Steam Server Status Widget =====
// ===========================================
let lastServerStatusCheck = 0;
let cachedServerStatus = null;

async function fetchSteamServerStatus(force = false) {
    const now = Date.now();
    // Cache for 60 seconds to avoid hammering the API
    if (!force && cachedServerStatus && (now - lastServerStatusCheck) < 60000) {
        return cachedServerStatus;
    }
    const result = await ipcRenderer.invoke('get-steam-status');
    if (result.success) {
        cachedServerStatus = result;
        lastServerStatusCheck = now;
    }
    return result;
}

function getStatusClass(status) {
    const s = (status || '').toLowerCase();
    if (s === 'normal' || s === 'good') return 'normal';
    if (s === 'minor' || s === 'slow') return 'minor';
    if (s === 'major' || s === 'critical') return 'major';
    if (s === 'offline' || s === 'down') return 'offline';
    return 'normal';
}

function getStatusLabel(status) {
    const cls = getStatusClass(status);
    return t(`servers.${cls}`);
}

async function renderServerStatusWidget() {
    const container = document.getElementById('serverStatusContent');
    if (!container) return;
    
    container.innerHTML = `<div style="text-align: center; padding: 1rem; color: var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> ${t('servers.checking')}</div>`;
    
    const result = await fetchSteamServerStatus(true);
    
    if (!result.success) {
        container.innerHTML = `<div style="text-align: center; padding: 1rem; color: var(--danger);"><i class="fa-solid fa-circle-exclamation"></i> ${t('servers.no_data')}</div>`;
        return;
    }
    
    const services = result.services;
    let html = '';
    
    // Show all services in their natural order
    for (const name in services) {
        const svc = services[name];
        const cls = getStatusClass(svc.status);
        const latencyText = svc.latency ? ` <span style="color: var(--text-muted); font-weight: 400; font-size: 0.7rem;">${svc.latency}ms</span>` : '';
        html += `
            <div class="server-row">
                <span class="server-name">${name}</span>
                <span class="server-status-badge ${cls}">
                    <span class="pulse"></span>
                    ${getStatusLabel(svc.status)}${latencyText}
                </span>
            </div>
        `;
    }
    
    const lastTime = new Date().toLocaleTimeString(currentLang === 'ar' ? 'ar-SA' : 'en-US');
    container.innerHTML = html + `<div style="text-align: center; font-size: 0.7rem; color: var(--text-muted); margin-top: 0.75rem;">${t('servers.last_checked')}: ${lastTime}</div>`;
}

// ===========================================
// ===== Extended Game Info Modal =====
// ===========================================
function readSteamAcfData(gameId) {
    if (!steamPath) return null;
    try {
        const acfPath = path.join(steamPath, 'steamapps', `appmanifest_${gameId}.acf`);
        if (!fs.existsSync(acfPath)) return null;
        const content = fs.readFileSync(acfPath, 'utf-8');
        const parsed = vdf.parse(content);
        const state = parsed.AppState || {};
        return {
            name: state.name,
            installDir: state.installdir ? path.join(steamPath, 'steamapps', 'common', state.installdir) : null,
            sizeOnDisk: state.SizeOnDisk ? parseInt(state.SizeOnDisk) : 0,
            lastUpdated: state.LastUpdated ? parseInt(state.LastUpdated) : 0,
            lastOwner: state.LastOwner,
            buildId: state.buildid
        };
    } catch(e) { console.error('readSteamAcfData', e); return null; }
}

function formatBytes(bytes) {
    if (!bytes) return '-';
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return gb.toFixed(2) + ' GB';
    const mb = bytes / (1024 * 1024);
    return mb.toFixed(1) + ' MB';
}

function formatDate(timestamp) {
    if (!timestamp) return '-';
    const date = new Date(timestamp * 1000);
    const days = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (days === 0) return currentLang === 'ar' ? 'اليوم' : 'Today';
    if (days === 1) return currentLang === 'ar' ? 'أمس' : 'Yesterday';
    if (days < 30) return `${days} ${currentLang === 'ar' ? 'يوم' : 'days'} ${t('gameinfo.ago')}`;
    return date.toLocaleDateString(currentLang === 'ar' ? 'ar-SA' : 'en-US');
}

function openGameInfoModal(gameId, gameName, platform = 'steam', bannerUrl = null) {
    const existing = document.getElementById('gameInfoOverlay');
    if (existing) existing.remove();
    
    const acfData = platform === 'steam' ? readSteamAcfData(gameId) : null;
    const playtime = playtimeData[gameId];
    const linkedAccount = platform === 'steam' ? resolveGameAccount(gameId, acfData?.lastOwner) : null;
    
    // Build banner
    const banner = bannerUrl 
        ? `<div class="game-info-banner" style="background-image: url('${bannerUrl}');"></div>`
        : (platform === 'steam'
            ? `<div class="game-info-banner" style="background-image: url('https://cdn.akamai.steamstatic.com/steam/apps/${gameId}/library_hero.jpg');"></div>`
            : '');
    
    const overlay = document.createElement('div');
    overlay.id = 'gameInfoOverlay';
    overlay.className = 'modal-overlay active';
    overlay.innerHTML = `
        <div class="modal game-info-modal">
            ${banner}
            <h2 style="margin-bottom: 0.25rem;">${gameName}</h2>
            <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 1rem;">
                ${getPlatformName(platform)}
                ${linkedAccount ? `<span style="margin: 0 0.5rem;">•</span> <i class="fa-solid fa-user"></i> ${linkedAccount}` : ''}
            </p>
            
            <div class="game-info-stats">
                <div class="game-stat-card">
                    <div class="label"><i class="fa-solid fa-clock"></i> ${t('gameinfo.total_playtime')}</div>
                    <div class="value">${playtime && playtime.totalSeconds ? formatPlaytime(playtime.totalSeconds) : t('gameinfo.never')}</div>
                </div>
                <div class="game-stat-card">
                    <div class="label"><i class="fa-solid fa-calendar-day"></i> ${t('gameinfo.last_played')}</div>
                    <div class="value small">${playtime && playtime.lastPlayed ? formatLastPlayed(playtime.lastPlayed) : '-'}</div>
                </div>
                <div class="game-stat-card">
                    <div class="label"><i class="fa-solid fa-hard-drive"></i> ${t('gameinfo.size_on_disk')}</div>
                    <div class="value">${acfData ? formatBytes(acfData.sizeOnDisk) : '-'}</div>
                </div>
                <div class="game-stat-card">
                    <div class="label"><i class="fa-solid fa-arrows-rotate"></i> ${t('gameinfo.last_updated')}</div>
                    <div class="value small">${acfData ? formatDate(acfData.lastUpdated) : '-'}</div>
                </div>
                <div class="game-stat-card">
                    <div class="label"><i class="fa-solid fa-play"></i> ${t('gameinfo.sessions')}</div>
                    <div class="value">${playtime?.sessions || 0}</div>
                </div>
                <div class="game-stat-card">
                    <div class="label"><i class="fa-solid fa-fingerprint"></i> ID</div>
                    <div class="value small">${gameId}</div>
                </div>
            </div>
            
            ${acfData?.installDir ? `
                <div style="background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.6rem 0.8rem; margin-bottom: 1rem; font-size: 0.78rem; color: var(--text-muted); word-break: break-all;">
                    <i class="fa-solid fa-folder" style="margin-left: 0.4rem;"></i> ${acfData.installDir}
                </div>
            ` : ''}
            
            <div class="modal-actions" style="flex-wrap: wrap; gap: 0.5rem;">
                ${acfData?.installDir ? `<button class="btn" id="gameInfoOpenFolder"><i class="fa-solid fa-folder-open"></i> ${t('gameinfo.open_folder')}</button>` : ''}
                ${platform === 'steam' ? `<button class="btn" id="gameInfoSteamPage"><i class="fa-brands fa-steam"></i> ${t('gameinfo.view_steam_page')}</button>` : ''}
                <button class="btn btn-primary" id="gameInfoClose">${t('modal.close')}</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    
    // Wire up actions
    const closeBtn = overlay.querySelector('#gameInfoClose');
    const closeModal = () => overlay.remove();
    closeBtn?.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    
    const openFolderBtn = overlay.querySelector('#gameInfoOpenFolder');
    if (openFolderBtn && acfData?.installDir) {
        openFolderBtn.addEventListener('click', () => {
            exec(`explorer "${acfData.installDir}"`);
        });
    }
    
    const steamPageBtn = overlay.querySelector('#gameInfoSteamPage');
    if (steamPageBtn) {
        steamPageBtn.addEventListener('click', () => {
            ipcRenderer.invoke('open-external', `https://store.steampowered.com/app/${gameId}/`);
        });
    }
}

window.openGameInfoModal = openGameInfoModal;

function savePlatformAccountsCatalog() {
    if (platformCatalogFile) writeEncryptedJson(platformCatalogFile, platformAccountsCatalog);
}

function mergePlatformAccountList(platform, diskAccounts) {
    const catalog = Array.isArray(platformAccountsCatalog[platform]) ? platformAccountsCatalog[platform] : [];
    const merged = [...new Set([...catalog, ...diskAccounts])].filter(Boolean);
    platformAccountsCatalog[platform] = merged;
    savePlatformAccountsCatalog();
    return merged;
}

function removeFromPlatformCatalog(platform, accName) {
    if (!platformAccountsCatalog[platform]) return;
    platformAccountsCatalog[platform] = platformAccountsCatalog[platform].filter(n => n !== accName);
    savePlatformAccountsCatalog();
}

async function getPlatformSessionInfo(platform) {
    const running = await ipcRenderer.invoke('is-platform-running', platform);
    const activeState = await ipcRenderer.invoke('get-platform-active-state');
    const lastActive = activeState[platform] || null;
    const activeAccount = running ? lastActive : null;
    return { running, activeAccount, lastActive };
}

function launchPlatformApp(platform) {
    const meta = PLATFORM_META[platform];
    if (meta && meta.launch) meta.launch();
}

function createPlatformAccountCard(platform, accName, meta, hasActiveSession, isCurrent) {
    const pickMode = !hasActiveSession;
    let actionHtml;
    let loginHint = '';
    if (isCurrent) {
        actionHtml = `<button class="btn btn-switch disabled" disabled><i class="fa-solid fa-circle-check"></i> ${t('account.logged_in')}</button>`;
    } else if (!hasActiveSession) {
        actionHtml = `<button class="btn btn-login-acc platform-login-btn" data-platform="${platform}" data-account="${accName}">
            <i class="fa-solid fa-right-to-bracket"></i> ${t('account.login')}
        </button>`;
        loginHint = `<p class="card-login-hint">${t('account.login_hint')}</p>`;
    } else {
        actionHtml = `<button class="btn btn-switch-acc platform-switch-btn" data-platform="${platform}" data-account="${accName}">
            <i class="fa-solid fa-arrow-right-arrow-left"></i> ${t('account.switch')}
        </button>`;
    }

    const card = document.createElement('div');
    card.className = `account-card platform-session-card${pickMode ? ' account-card--pick' : ''}${hasActiveSession && !isCurrent ? ' account-card--other' : ''}${isCurrent ? ' active-account' : ''}`;
    card.innerHTML = `
        <div class="card-header">
            <div class="profile-pic placeholder-pic" style="background: ${meta.color}; color: white; padding: 0;">
                <i class="${meta.icon}" style="font-size: 2rem;"></i>
            </div>
            ${isCurrent ? `<div class="account-status">${t('account.logged_in')}</div>` : ''}
        </div>
        <div class="card-body">
            <h3>${accName}</h3>
            <p class="steam-id">${meta.name}</p>
            ${loginHint}
        </div>
        <div class="card-actions">
            ${actionHtml}
            <button class="btn-icon platform-dropdown-btn" data-platform="${platform}" data-account="${accName}">
                <i class="fa-solid fa-ellipsis-vertical"></i>
            </button>
        </div>`;
    return card;
}

function renderPlatformHero(heroEl, platform, meta, sessionInfo, activeAccount) {
    const hasActiveSession = sessionInfo.running && activeAccount;
    heroEl.innerHTML = '';
    const hero = document.createElement('div');
    hero.className = `session-hero ${hasActiveSession ? 'session-hero--active' : 'session-hero--idle'}`;

    if (hasActiveSession) {
        hero.innerHTML = `
            <div class="session-hero-bg"></div>
            <div class="session-hero-content">
                <div class="session-hero-avatar" style="border-color: ${meta.color}; box-shadow: 0 0 0 4px ${meta.color}33;">
                    <i class="${meta.icon}" style="font-size: 2.5rem; color: white;"></i>
                </div>
                <div class="session-hero-info">
                    <span class="session-badge session-badge--online"><span class="pulse-dot"></span> ${t('account.logged_in')}</span>
                    <h2>${activeAccount}</h2>
                    <div class="session-hero-meta">
                        <span class="meta-item"><i class="${meta.icon}"></i> ${meta.name}</span>
                        <span class="meta-item">${t('platform.launcher_running')}</span>
                    </div>
                </div>
                <div class="session-hero-actions">
                    <button class="btn btn-primary platform-open-btn" type="button" data-platform="${platform}">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i> ${t('platform.open_launcher')}
                    </button>
                </div>
            </div>`;
    } else {
        const statusLabel = sessionInfo.running ? t('platform.launcher_running') : t('platform.launcher_stopped');
        hero.innerHTML = `
            <div class="session-hero-bg"></div>
            <div class="session-hero-content">
                <div class="session-hero-icon-wrap" style="border-color: ${meta.color}55; color: ${meta.color};">
                    <i class="${meta.icon}"></i>
                </div>
                <div class="session-hero-info">
                    <span class="session-badge session-badge--login">${statusLabel}</span>
                    <h2>${t('platform.no_session_title')}</h2>
                    <p style="color: var(--text-muted); font-size: 0.9rem; margin: 0;">${t('platform.no_session_desc')}</p>
                </div>
                <div class="session-hero-actions">
                    <button class="btn btn-primary platform-open-btn" type="button" data-platform="${platform}">
                        <i class="fa-solid fa-play"></i> ${t('platform.open_launcher')}
                    </button>
                </div>
            </div>`;
    }
    heroEl.appendChild(hero);
    hero.querySelector('.platform-open-btn')?.addEventListener('click', () => launchPlatformApp(platform));
}

function bindPlatformAccountActions(sectionEl) {
    sectionEl.querySelectorAll('.platform-login-btn, .platform-switch-btn').forEach(btn => {
        btn.addEventListener('click', async function() {
            const platform = this.getAttribute('data-platform');
            const accName = this.getAttribute('data-account');
            const isLogin = this.classList.contains('platform-login-btn');

            this.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> ${t('account.switching')}`;
            this.style.pointerEvents = 'none';

            isSwitchingPlatform = true;
            const res = await ipcRenderer.invoke('switch-platform-session', platform, accName);
            if (res.success) {
                await ipcRenderer.invoke('set-platform-active-state', platform, accName);
                const waitMsg = platform === 'epic'
                    ? (currentLang === 'ar' ? 'جاري فتح Epic... انتظر حتى يظهر الحساب' : 'Opening Epic... wait for the account to load')
                    : `${t('toast.account_switched')}: ${accName}`;
                showToast(waitMsg, 'success', { duration: platform === 'epic' ? 5000 : 3500 });
                if (!res.launched) launchPlatformApp(platform);
                const delays = platform === 'epic' ? [3000, 6000, 12000] : [1500, 4000, 8000];
                for (const ms of delays) {
                    await new Promise(r => setTimeout(r, ms));
                    await renderPlatformAccountsSections();
                }
            } else {
                showToast(res.error, 'error');
            }
            isSwitchingPlatform = false;
            await renderPlatformAccountsSections();
        });
    });

    sectionEl.querySelectorAll('.platform-dropdown-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const existing = document.querySelector('.dropdown-popup');
            if (existing) { existing.remove(); return; }

            const platform = btn.getAttribute('data-platform');
            const accName = btn.getAttribute('data-account');
            const btnRect = btn.getBoundingClientRect();

            const popup = document.createElement('div');
            popup.className = 'dropdown-popup';
            popup.style.cssText = `position: fixed; top: ${btnRect.top - 6}px; left: ${btnRect.left}px; transform: translateY(-100%); background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 10px; padding: 0.5rem; z-index: 999; box-shadow: 0 10px 25px rgba(0,0,0,0.5); min-width: 170px; direction: rtl;`;
            popup.innerHTML = `
                <button class="btn rename-platform-btn" data-platform="${platform}" data-account="${accName}" style="width: 100%; justify-content: flex-start; background: transparent; color: var(--text-main); border: none; padding: 0.5rem; font-size: 0.9rem; cursor: pointer; border-radius: 6px; display: flex; align-items: center; gap: 0.5rem; font-family: inherit;">
                    <i class="fa-solid fa-pen"></i> ${t('account.rename')}
                </button>
                <button class="btn delete-platform-btn" data-platform="${platform}" data-account="${accName}" style="width: 100%; justify-content: flex-start; background: transparent; color: var(--danger); border: none; padding: 0.5rem; font-size: 0.9rem; cursor: pointer; border-radius: 6px; display: flex; align-items: center; gap: 0.5rem; font-family: inherit;">
                    <i class="fa-solid fa-trash"></i> ${t('account.delete')}
                </button>`;
            document.body.appendChild(popup);

            requestAnimationFrame(() => {
                const popupRect = popup.getBoundingClientRect();
                if (popupRect.top < 0) {
                    popup.style.top = `${btnRect.bottom + 6}px`;
                    popup.style.transform = 'none';
                }
            });

            popup.querySelector('.rename-platform-btn')?.addEventListener('click', async () => {
                const newName = (prompt(t('account.rename_prompt'), accName) || '').trim();
                if (!newName || newName === accName) return;
                if (platformAccountsCatalog?.[platform]?.includes(newName)) {
                    showToast(t('account.rename_exists'), 'warning');
                    return;
                }
                // Update catalog
                platformAccountsCatalog[platform] = (platformAccountsCatalog[platform] || []).map(n => n === accName ? newName : n);
                savePlatformAccountsCatalog();
                // Update active state if needed
                const activeState = await ipcRenderer.invoke('get-platform-active-state');
                if (activeState[platform] === accName) {
                    await ipcRenderer.invoke('set-platform-active-state', platform, newName);
                }
                popup.remove();
                await loadSteamAccounts();
                await renderPlatformAccountsSections();
            });

            popup.querySelector('.delete-platform-btn').addEventListener('click', async () => {
                if (confirm(t('account.delete_confirm'))) {
                    popup.remove();
                    await ipcRenderer.invoke('delete-platform-session', platform, accName);
                    removeFromPlatformCatalog(platform, accName);
                    const activeState = await ipcRenderer.invoke('get-platform-active-state');
                    if (activeState[platform] === accName) {
                        await ipcRenderer.invoke('set-platform-active-state', platform, null);
                    }
                    await loadSteamAccounts();
                    await renderPlatformAccountsSections();
                }
            });
        });
    });
}

async function renderPlatformAccountsSections() {
    const container = document.getElementById('platformAccountsContainer');
    if (!container) return;

    try {
        const sessions = await ipcRenderer.invoke('get-platform-sessions');
        container.innerHTML = '';

        for (const platform of Object.keys(PLATFORM_META)) {
            const meta = PLATFORM_META[platform];
            const diskAccounts = sessions[platform] || [];
            const accounts = mergePlatformAccountList(platform, diskAccounts);
            if (accounts.length === 0) continue;

            const sessionInfo = await getPlatformSessionInfo(platform);
            const activeAccount = sessionInfo.activeAccount;
            const hasActiveSession = !!(sessionInfo.running && activeAccount);

            const section = document.createElement('section');
            section.className = 'accounts-platform-block platform-section';
            section.dataset.platform = platform;

            section.innerHTML = `
                <div class="accounts-platform-title">
                    <i class="${meta.icon}" style="color: ${meta.color};"></i>
                    <span>${meta.name}</span>
                    <button type="button" class="btn platform-save-session-btn" data-platform="${platform}">
                        <i class="fa-solid fa-floppy-disk"></i> ${t('platform.save_session_btn')}
                    </button>
                </div>
                <div class="platform-hero-slot"></div>
                <div class="accounts-section-label platform-section-label"></div>
                <div class="accounts-grid platform-accounts-grid"></div>`;

            const heroSlot = section.querySelector('.platform-hero-slot');
            const labelEl = section.querySelector('.platform-section-label');
            const grid = section.querySelector('.platform-accounts-grid');

            renderPlatformHero(heroSlot, platform, meta, sessionInfo, activeAccount);

            const sorted = [...accounts].sort((a, b) => {
                if (hasActiveSession) {
                    if (a === activeAccount) return -1;
                    if (b === activeAccount) return 1;
                }
                return a.localeCompare(b, currentLang);
            });

            if (labelEl) {
                labelEl.style.display = 'flex';
                labelEl.textContent = hasActiveSession ? t('account.all_accounts') : t('account.choose_account');
            }

            sorted.forEach(accName => {
                const isCurrent = hasActiveSession && accName === activeAccount;
                grid.appendChild(createPlatformAccountCard(platform, accName, meta, hasActiveSession, isCurrent));
            });

            container.appendChild(section);
            section.querySelector('.platform-save-session-btn')?.addEventListener('click', () => {
                if (typeof window.openAddAccountModal === 'function') {
                    window.openAddAccountModal(platform);
                }
            });
            bindPlatformAccountActions(section);
        }
    } catch (e) {
        console.error('Error rendering platform accounts:', e);
    }
}

