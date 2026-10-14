// Compiles src/registry.compact into src/managed/registry.
// Pass --keys to also generate proving keys (slow; needed only for deployment).
// Compact has no native Windows build, so on Windows this runs the compiler in WSL
// (distro from CG_WSL_DISTRO, default Ubuntu). Install it with scripts/setup-wsl.sh.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = [...(process.argv.includes('--keys') ? [] : ['--skip-zk']), 'src/registry.compact', 'src/managed/registry'];

if (process.platform === 'win32') {
  const distro = process.env.CG_WSL_DISTRO ?? 'Ubuntu';
  const linuxRoot = execFileSync('wsl', ['-d', distro, '--', 'wslpath', '-a', root.replace(/\\/g, '/')]).toString().trim();
  const script = `export PATH="$HOME/.local/bin:$HOME/.compact/bin:$PATH"; cd '${linuxRoot}' && compact compile ${args.join(' ')}`;
  execFileSync('wsl', ['-d', distro, '--', 'bash', '-lc', script], { stdio: 'inherit' });
} else {
  execFileSync('compact', ['compile', ...args], { cwd: root, stdio: 'inherit' });
}
