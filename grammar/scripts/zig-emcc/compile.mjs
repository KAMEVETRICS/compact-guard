// Optional build-time adapter for tree-sitter-cli 0.25.10's fixed emcc invocation.
// This is NOT a general emcc replacement. The runtime needs only web-tree-sitter.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const input = process.argv.slice(2);
if (!input.length) {
  console.log('Compact tree-sitter WASM adapter (Zig 0.14.1)');
  process.exit(0);
}
const zig = process.env.COMPACT_ZIG;
const sysroot = process.env.COMPACT_EMSCRIPTEN_SYSROOT;
if (!zig || !sysroot) throw new Error('Set COMPACT_ZIG to zig.exe and COMPACT_EMSCRIPTEN_SYSROOT to Emscripten cache/sysroot.');
const args = ['cc', '-target', 'wasm32-emscripten', '-shared', '-fPIC', '-nostdlib',
  '-isystem', join(sysroot, 'include'), '-Wl,--no-entry', '-Wl,--import-memory'];
const settings = new Set(['WASM=1', 'SIDE_MODULE=2', 'TOTAL_MEMORY=33554432', 'NODEJS_CATCH_EXIT=0']);
for (let i = 0; i < input.length; i++) {
  const arg = input[i];
  if (arg === '-s') {
    const setting = input[++i];
    if (setting === 'EXPORTED_FUNCTIONS=["_tree_sitter_compact"]' || setting === 'EXPORTED_FUNCTIONS=[_tree_sitter_compact]') {
      args.push('-Wl,--export=tree_sitter_compact');
    } else if (!settings.has(setting)) throw new Error(`Unsupported emcc setting: ${setting}`);
  } else if (arg === '-o' || arg === '-I') {
    if (!input[i + 1]) throw new Error(`Missing value for ${arg}`);
    args.push(arg, input[++i]);
  } else if (['-Os', '-fno-exceptions', '-fvisibility=hidden', 'parser.c'].includes(arg)) {
    args.push(arg);
  } else throw new Error(`Unsupported emcc argument: ${arg}`);
}
console.error('Building Compact WASM with the explicit Zig adapter.');
const result = spawnSync(zig, args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
