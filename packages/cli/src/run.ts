import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HELP, parseCli, UsageError } from './args.js';
import { renderJson, renderText } from './report.js';
import { renderSarif } from './sarif.js';
import { RANK, scan } from './scan.js';

export interface Io {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: Io = {
  cwd: process.cwd(),
  stdout: text => { process.stdout.write(text); },
  stderr: text => { process.stderr.write(text); },
};

async function packageInfo(): Promise<{ version: string; homepage?: string }> {
  return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
}

/** Runs the CLI and returns its exit code: 0 clean, 1 findings at or above --fail-on, 2 usage or internal error. */
export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  try {
    const options = parseCli(argv);
    const pkg = await packageInfo();
    if (options.help) { io.stdout(HELP); return 0; }
    if (options.version) { io.stdout(`${pkg.version}\n`); return 0; }

    const files = await scan(options.paths, io.cwd, {
      ...(options.rules ? { rules: options.rules } : {}),
      ...(options.oneTime.length ? { oneTimeCircuits: options.oneTime } : {}),
    });

    const report = options.format === 'sarif' ? renderSarif(files, io.cwd, { version: pkg.version, informationUri: pkg.homepage })
      : options.format === 'json' ? renderJson(files, io.cwd, pkg.version)
      : renderText(files, io.cwd, options);
    if (options.output) await writeFile(resolve(io.cwd, options.output), report, 'utf8');
    else io.stdout(report);

    if (options.failOn === 'none') return 0;
    const threshold = RANK[options.failOn];
    return files.some(({ result }) => result.findings.some(f => RANK[f.severity] >= threshold)) ? 1 : 0;
  } catch (error) {
    if (error instanceof UsageError) io.stderr(`compact-guard: ${error.message}\nRun compact-guard --help for usage.\n`);
    else io.stderr(`compact-guard: internal error: ${(error as Error)?.stack ?? error}\n`);
    return 2;
  }
}
