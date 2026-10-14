import { parseArgs } from 'node:util';
import { RULE_BY_ID, type RuleId } from '@compact-guard/analyzer';

export type Format = 'text' | 'json' | 'sarif';
export type FailOn = 'error' | 'warning' | 'review' | 'none';

export interface CliOptions {
  paths: string[];
  format: Format;
  output?: string;
  rules?: RuleId[];
  oneTime: string[];
  failOn: FailOn;
  quiet: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {}

const FORMATS: readonly Format[] = ['text', 'json', 'sarif'];
const FAIL_ON: readonly FailOn[] = ['error', 'warning', 'review', 'none'];

export const HELP = `Usage: compact-guard [options] [paths...]

Scan Midnight Compact contracts (.compact files, or directories searched
recursively) for security mistakes the compiler does not catch.
With no paths, scans the current directory.

Options:
  --format <text|json|sarif>  Output format (default: text)
  --output <file>             Write the report to a file instead of stdout
  --rules <ids>               Comma-separated rule IDs to run, e.g. CG001,CG004
  --one-time <circuit>        Treat a circuit as one-time for CG008 (repeatable)
  --fail-on <level>           error | warning | review | none (default: error)
  --quiet                     Text format: print findings only, no summary
  --verbose                   Text format: also print analyzer diagnostics
  --version                   Print the version and exit
  --help                      Print this help and exit

Exit codes:
  0  no finding at or above --fail-on
  1  at least one finding at or above --fail-on
  2  usage error or internal failure
`;

export function parseCli(argv: string[]): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        format: { type: 'string', default: 'text' },
        output: { type: 'string' },
        rules: { type: 'string' },
        'one-time': { type: 'string', multiple: true, default: [] },
        'fail-on': { type: 'string', default: 'error' },
        quiet: { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;

  const format = values.format as Format;
  if (!FORMATS.includes(format)) throw new UsageError(`--format must be one of ${FORMATS.join(', ')}; got "${values.format}"`);
  const failOn = values['fail-on'] as FailOn;
  if (!FAIL_ON.includes(failOn)) throw new UsageError(`--fail-on must be one of ${FAIL_ON.join(', ')}; got "${values['fail-on']}"`);

  let rules: RuleId[] | undefined;
  if (values.rules !== undefined) {
    rules = values.rules.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) as RuleId[];
    const unknown = rules.filter(id => !RULE_BY_ID.has(id));
    if (unknown.length) throw new UsageError(`unknown rule ID(s): ${unknown.join(', ')}`);
    if (!rules.length) throw new UsageError('--rules needs at least one rule ID');
  }

  return {
    paths: positionals.length ? positionals : ['.'],
    format,
    output: values.output,
    rules,
    oneTime: values['one-time'] as string[],
    failOn,
    quiet: values.quiet as boolean,
    verbose: values.verbose as boolean,
    help: values.help as boolean,
    version: values.version as boolean,
  };
}
