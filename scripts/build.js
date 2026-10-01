// NSIS (used by electron-builder) writes the installer through the system ANSI
// code page. A project path with Arabic characters is corrupted, so makensis
// fails with "Can't open output file". Build into an ASCII directory, then
// copy the finished artifacts back into ./dist with Node (Unicode-safe).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.resolve(__dirname, '..');
const nonAscii = /[^\u0000-\u007f]/.test(root);
const outDir = nonAscii
    ? path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'nexus-switcher-dist')
    : path.join(root, 'dist');

fs.mkdirSync(outDir, { recursive: true });
const outputArg = outDir.replace(/\\/g, '/');

const result = spawnSync(
    'npx',
    ['electron-builder', '--win', `--config.directories.output=${outputArg}`],
    { cwd: root, stdio: 'inherit', shell: true, env: process.env }
);

if (result.status !== 0) {
    process.exit(result.status || 1);
}

if (nonAscii) {
    const dist = path.join(root, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    copyTree(outDir, dist);
    console.log(`\nBuild output copied to ${dist}`);
}

function copyTree(from, to) {
    if (fs.statSync(from).isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        for (const name of fs.readdirSync(from)) {
            copyTree(path.join(from, name), path.join(to, name));
        }
        return;
    }
    // OneDrive often fails fs.cpSync with a bogus "operation completed
    // successfully" while unlinking the old file. Write beside it, then replace.
    const data = fs.readFileSync(from);
    const tmp = `${to}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    try {
        if (fs.existsSync(to)) fs.rmSync(to, { force: true });
        fs.renameSync(tmp, to);
    } catch (e) {
        fs.writeFileSync(to, data);
        try { fs.rmSync(tmp, { force: true }); } catch (err) {}
    }
}
