import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Parser, Language } from 'web-tree-sitter';

let parser;
before(async () => {
  await Parser.init();
  parser = new Parser();
  parser.setLanguage(await Language.load(fileURLToPath(new URL('../tree-sitter-compact.wasm', import.meta.url))));
});
after(() => parser?.delete());

function parse(source, fn) {
  const tree = parser.parse(source);
  try { assert.equal(tree.rootNode.hasError, false, tree.rootNode.toString()); fn(tree.rootNode); }
  finally { tree.delete(); }
}
const field = (node, name) => {
  const result = node.childForFieldName(name);
  assert.ok(result, `Missing ${name} on ${node.type}`);
  return result;
};
const first = (root, type) => { const node = root.descendantsOfType(type)[0]; assert.ok(node, type); return node; };

test('declaration fields expose names, qualifiers, parameters, types and bodies', () => {
  parse('export sealed ledger key: Bytes<32>; export pure circuit hash<#N, T>(x: T): T { return x; } witness secret(): Field;', root => {
    const ledger = first(root, 'ledger_declaration');
    assert.equal(field(ledger, 'name').text, 'key');
    assert.equal(field(ledger, 'sealed').text, 'sealed');
    assert.equal(field(field(ledger, 'type'), 'size').text, '32');
    const circuit = first(root, 'circuit_declaration');
    assert.equal(field(circuit, 'export').text, 'export');
    assert.equal(field(circuit, 'pure').text, 'pure');
    assert.equal(field(circuit, 'name').text, 'hash');
    assert.equal(field(circuit, 'return_type').text, 'T');
    assert.equal(field(circuit, 'type_params').namedChildCount, 2);
    const param = field(circuit, 'params').namedChildren[0];
    assert.equal(field(param, 'name').text, 'x');
    assert.equal(field(param, 'type').text, 'T');
    assert.equal(field(circuit, 'body').type, 'block');
  });
});

test('operator grouping follows Compact precedence, including low-precedence casts', () => {
  parse('pure circuit f(): Field { return a + b * c as Field; }', root => {
    const cast = field(first(root, 'return_statement'), 'value');
    assert.equal(cast.type, 'cast_expression');
    const plus = field(cast, 'value');
    assert.equal(field(plus, 'operator').text, '+');
    assert.equal(field(field(plus, 'right'), 'operator').text, '*');
  });
  parse('circuit f(): [] { a = b = c; if (a) if (b) f(); else g(); }', root => {
    const assignment = first(root, 'assignment_expression');
    assert.equal(field(assignment, 'right').type, 'assignment_expression');
    const outer = first(root, 'if_statement');
    assert.equal(outer.childForFieldName('alternative'), null);
    assert.ok(field(outer, 'consequence').childForFieldName('alternative'));
  });
});

test('generic functions, nested type arguments and comparisons remain distinct', () => {
  parse('circuit f(): [] { const a = hash<10, Bytes<32>>(x); const b = x < y; const c = x as Field < y; store.lookup(a).value; }', root => {
    const call = first(root, 'call_expression');
    const fun = field(call, 'function');
    assert.equal(fun.type, 'generic_function');
    assert.equal(field(fun, 'name').text, 'hash');
    assert.equal(field(fun, 'args').namedChildCount, 2);
    assert.equal(field(call, 'args').namedChildCount, 1);
    assert.equal(root.descendantsOfType('binary_expression').length, 2);
    assert.equal(first(root, 'member_expression').type, 'member_expression');
  });
});

test('disclosure and assertion expose analyzable operands', () => {
  parse('circuit f(): [] { assert(disclose(secret()) == expected, "auth"); }', root => {
    const assertion = first(root, 'assert_expression');
    assert.equal(field(assertion, 'message').text, '"auth"');
    const comparison = field(assertion, 'condition');
    const disclosure = field(comparison, 'left');
    assert.equal(disclosure.type, 'disclose_expression');
    assert.equal(field(disclosure, 'value').type, 'call_expression');
  });
});

test('single generic type and numeric arguments are calls, not relational operators', () => {
  for (const expr of ['f<T>(x)', 'f<10>(x)', '(f<T>)(x)']) {
    parse(`circuit f(): [] { ${expr}; }`, root => {
      assert.equal(root.descendantsOfType('call_expression').length, 1);
      assert.equal(root.descendantsOfType('generic_function').length, 1);
      assert.equal(root.descendantsOfType('binary_expression').length, 0);
    });
  }
});

test('raw newlines cannot be hidden by extras inside a quoted string', () => {
  for (const value of ['"text\n"', "'text\r\n'", '"text\nmore"']) {
    const tree = parser.parse(`circuit f(): [] { ${value}; }`);
    assert.ok(tree.rootNode.hasError, JSON.stringify(value));
    tree.delete();
  }
  parse('circuit f(): [] { "text\\\ncontinued"; }', () => {});
});

test('reserved words are rejected but keyword prefixes and Unicode names work', () => {
  for (const name of ['while', 'return', 'let', 'class', 'Uint', 'false', 'arguments']) {
    const tree = parser.parse(`ledger ${name}: Field;`);
    assert.ok(tree.rootNode.hasError, name);
    tree.delete();
  }
  parse('ledger whileCount: Field; ledger returnValue: Field; ledger café: Field; ledger $name: Field;', () => {});
});

test('TypeScript identifier characters, Unicode escapes and CR string continuations parse', () => {
  parse('ledger \\u0061: Field; ledger \\u{62}: Field; ledger a\\u0062: Field; ledger \u037a: Field;', root => {
    assert.equal(root.descendantsOfType('ledger_declaration').length, 4);
  });
  parse('circuit f(): [] { "a\\\rb"; }', () => {});
});

test('hexadecimal and Unicode string escapes require complete digits', () => {
  for (const value of ['"\\xZZ"', '"\\u123Z"', '"\\x1"', '"\\u{}"']) {
    const tree = parser.parse(`circuit f(): [] { ${value}; }`);
    assert.ok(tree.rootNode.hasError, value);
    tree.delete();
  }
  parse('circuit f(): [] { "\\x41\\u0042\\u{43}\\n\\q"; }', () => {});
});

test('all corpus examples parse through the shipped WASM without recovery', async () => {
  for (const file of ['declarations.txt', 'expressions.txt']) {
    const text = await readFile(new URL(`corpus/${file}`, import.meta.url), 'utf8');
    const examples = [...text.matchAll(/={10,}\r?\n([^\n]+)\r?\n={10,}\r?\n([\s\S]*?)\r?\n---\r?\n/g)];
    assert.ok(examples.length > 0);
    for (const [, name, source] of examples) parse(source, () => assert.ok(name));
  }
});

test('parse-all recurses, reports ERROR and MISSING with locations, and fails empty inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'compact-parser-test-'));
  const script = fileURLToPath(new URL('../scripts/parse-all.mjs', import.meta.url));
  const run = path => spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
  try {
    assert.equal(run(dir).status, 2);
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'nested', 'valid.compact'), 'ledger x: Field;');
    let result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 files, 0 ERROR, 0 MISSING/);
    await writeFile(join(dir, 'bad.compact'), 'ledger x: Field;\n@');
    await writeFile(join(dir, 'missing.compact'), 'ledger x: Field');
    result = run(dir);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /bad\.compact:2:1: ERROR/);
    assert.match(result.stdout, /missing\.compact:1:16: MISSING/);
    // Tree-sitter emits an outer recovery ERROR and an inner lexical ERROR.
    assert.match(result.stdout, /3 files, 2 ERROR, 1 MISSING/);
    assert.equal(run(join(dir, 'does-not-exist')).status, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
