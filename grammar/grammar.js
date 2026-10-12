// Public AST: src/node-types.json. Record published renames in CHANGES.md.
const commaSep1 = rule => seq(rule, repeat(seq(',', rule)));
const commaSep = rule => optional(seq(commaSep1(rule), optional(',')));
const separated = rule => choice(
  optional(seq(rule, repeat(seq(';', rule)), optional(';'))),
  seq(rule, repeat(seq(',', rule)), optional(',')),
);
const exported = () => optional(field('export', 'export'));
const FUTURE = 'arguments await break case catch class continue debugger delete do eval event extends finally function in instanceof interface let null package private protected public static super switch this throw try typeof var void while with yield'.split(' ');
// Tree-sitter reserved sets require grammar tokens. Future keywords have no
// productions, so subtract precisely these complete words from the identifier
// lexer with a prefix trie (Rust regex supports character-class intersection).
function identifierPattern() {
  const root = {};
  for (const word of FUTURE) {
    let node = root;
    for (const ch of word) node = node[ch] ??= {};
    node.end = true;
  }
  const start = '$_\\p{ID_Start}';
  const rest = '$_\\u200c\\u200d\\p{ID_Continue}';
  const escape = '\\\\u([a-fA-F0-9]{4}|\\{[a-fA-F0-9]+\\})';
  function visit(node, first = false) {
    const keys = Object.keys(node).filter(k => k !== 'end');
    const cls = first ? start : rest;
    const other = keys.length ? `[${cls}&&[^${keys.join('')}]]` : `[${cls}]`;
    const choices = [`(${other}|${escape})([${rest}]|${escape})*`, ...keys.map(k => k + visit(node[k]))];
    if (!first && !node.end) choices.push('');
    return '(' + choices.join('|') + ')';
  }
  return new RegExp(visit(root, true));
}

module.exports = grammar({
  name: 'compact',
  extras: $ => [/[\s\uFEFF]/, $.comment],
  word: $ => $.identifier,
  supertypes: $ => [$.expression, $.statement, $.type, $.pattern],
  reserved: {
    global: $ => [
      'export', 'from', 'import', 'module', 'prefix', 'as', 'assert', 'circuit',
      'const', 'constructor', 'contract', 'default', 'disclose', 'else', 'emit',
      'enum', 'fold', 'for', 'if', 'implements', 'include', 'ledger', 'map',
      'new', 'of', 'pad', 'pragma', 'pure', 'return', 'sealed', 'slice',
      'struct', 'type', 'witness', 'Boolean', 'Bytes', 'Field', 'Opaque',
      'Uint', 'Vector', 'false', 'true',
    ],
  },
  conflicts: $ => [
    [$.type_reference],
    [$.type_reference, $.expression, $.generic_function],
    [$.pattern, $.expression],
    [$.tuple_pattern, $.tuple_literal],
  ],
  rules: {
    source_file: $ => repeat($._declaration),
    _declaration: $ => choice(
      $.pragma, $.include_declaration, $.import_declaration, $.export_declaration,
      $.module_declaration, $.ledger_declaration, $.witness_declaration,
      $.constructor_declaration, $.circuit_declaration, $.struct_declaration,
      $.enum_declaration, $.contract_declaration, $.type_alias_declaration,
      $.implements_declaration,
    ),
    pragma: $ => seq('pragma', field('name', $.identifier), field('version', $._version), ';'),
    _version: $ => choice($.version_literal, $.version_constraint, $.version_binary_expression, $.version_group),
    version_literal: _ => /[0-9]+(\.[0-9]+){0,2}/,
    version_constraint: $ => seq(field('operator', choice('!', '<', '<=', '>=', '>')), field('version', $.version_literal)),
    version_binary_expression: $ => choice(...[['||', 1], ['&&', 2]].map(([op, p]) =>
      prec.left(p, seq(field('left', $._version), field('operator', op), field('right', $._version))))),
    version_group: $ => seq('(', field('version', $._version), ')'),
    include_declaration: $ => seq('include', field('path', $.string_literal), ';'),
    import_declaration: $ => seq('import', optional(field('selection', $.import_selection)),
      field('name', choice($.identifier, $.string_literal)), optional(field('args', $.generic_arguments)),
      optional(seq('prefix', field('prefix', $.identifier))), ';'),
    import_selection: $ => seq('{', commaSep(field('element', $.import_specifier)), '}', 'from'),
    import_specifier: $ => seq(field('name', $.identifier), optional(seq('as', field('alias', $.identifier)))),
    export_declaration: $ => seq('export', '{', commaSep(field('name', $.identifier)), '}', optional(';')),
    module_declaration: $ => seq(exported(), 'module', field('name', $.identifier),
      optional(field('type_params', $.generic_parameters)), field('body', $.module_body)),
    module_body: $ => seq('{', repeat($._declaration), '}'),
    generic_parameters: $ => seq('<', commaSep(field('param', $.generic_parameter)), '>'),
    generic_parameter: $ => seq(optional(field('kind', '#')), field('name', $.identifier)),
    generic_arguments: $ => seq('<', commaSep(field('arg', choice($.number_literal, $.type))), '>'),
    ledger_declaration: $ => seq(exported(), optional(field('sealed', 'sealed')), 'ledger',
      field('name', $.identifier), ':', field('type', $.type), ';'),
    witness_declaration: $ => seq(exported(), 'witness', field('name', $.identifier),
      optional(field('type_params', $.generic_parameters)), field('params', $.simple_parameter_list),
      ':', field('return_type', $.type), ';'),
    constructor_declaration: $ => seq('constructor', field('params', $.parameter_list), field('body', $.block)),
    circuit_declaration: $ => seq(exported(), optional(field('pure', 'pure')), 'circuit', field('name', $.identifier),
      optional(field('type_params', $.generic_parameters)), field('params', $.parameter_list),
      ':', field('return_type', $.type), field('body', $.block)),
    struct_declaration: $ => seq(exported(), 'struct', field('name', $.identifier),
      optional(field('type_params', $.generic_parameters)), field('body', $.struct_body), optional(';')),
    struct_body: $ => seq('{', separated(field('member', $.struct_field)), '}'),
    struct_field: $ => seq(field('name', $.identifier), ':', field('type', $.type)),
    enum_declaration: $ => seq(exported(), 'enum', field('name', $.identifier), field('body', $.enum_body), optional(';')),
    enum_body: $ => seq('{', commaSep1(field('member', $.identifier)), optional(','), '}'),
    contract_declaration: $ => seq(exported(), 'contract', field('name', $.identifier), field('body', $.contract_body), optional(';')),
    contract_body: $ => seq('{', separated(field('member', $.circuit_signature)), '}'),
    circuit_signature: $ => seq(optional(field('pure', 'pure')), 'circuit', field('name', $.identifier),
      field('params', $.simple_parameter_list), ':', field('return_type', $.type)),
    implements_declaration: $ => seq('contract', 'implements', field('type', $.type), ';'),
    type_alias_declaration: $ => seq(exported(), optional(field('new', 'new')), 'type', field('name', $.identifier),
      optional(field('type_params', $.generic_parameters)), '=', field('type', $.type), ';'),
    simple_parameter_list: $ => seq('(', commaSep(field('param', $.simple_parameter)), ')'),
    simple_parameter: $ => seq(field('name', $.identifier), ':', field('type', $.type)),
    parameter_list: $ => seq('(', commaSep(field('param', $.typed_parameter)), ')'),
    typed_parameter: $ => seq(field('name', $.pattern), ':', field('type', $.type)),
    arrow_parameter_list: $ => seq('(', commaSep(field('param', $.parameter)), ')'),
    parameter: $ => seq(field('name', $.pattern), optional(seq(':', field('type', $.type)))),

    type: $ => choice($.type_reference, $.primitive_type, $.uint_type, $.bytes_type, $.opaque_type, $.vector_type, $.tuple_type),
    primitive_type: _ => choice('Field', 'Boolean'),
    type_reference: $ => seq(field('name', $.identifier), optional(field('args', $.generic_arguments))),
    uint_type: $ => seq('Uint', '<', choice(field('size', $._type_size), field('range', $.type_range)), '>'),
    type_range: $ => seq(field('start', $._type_size), '..', field('end', $._type_size)),
    bytes_type: $ => seq('Bytes', '<', field('size', $._type_size), '>'),
    opaque_type: $ => seq('Opaque', '<', field('name', $.string_literal), '>'),
    vector_type: $ => seq('Vector', '<', field('size', $._type_size), ',', field('type', $.type), '>'),
    tuple_type: $ => seq('[', commaSep(field('type', $.type)), ']'),
    _type_size: $ => choice($.number_literal, $.identifier),

    block: $ => seq('{', repeat($.statement), '}'),
    statement: $ => choice($.block, $.expression_statement, $.const_declaration, $.if_statement, $.for_statement, $.return_statement),
    expression_statement: $ => seq(field('expression', $._expression_sequence), ';'),
    const_declaration: $ => seq('const', commaSep1(field('binding', $.const_binding)), ';'),
    const_binding: $ => seq(field('name', $.pattern), optional(seq(':', field('type', $.type))), '=', field('value', $.expression)),
    if_statement: $ => prec.right(seq('if', '(', field('condition', $._expression_sequence), ')',
      field('consequence', $.statement), optional(seq('else', field('alternative', $.statement))))),
    for_statement: $ => seq('for', '(', 'const', field('name', $.identifier), 'of',
      field('iterable', choice($.range_expression, $._expression_sequence)), ')', field('body', $.statement)),
    range_expression: $ => seq(field('start', $._type_size), '..', field('end', $._type_size)),
    return_statement: $ => seq('return', optional(field('value', $._expression_sequence)), ';'),
    pattern: $ => choice($.identifier, $.tuple_pattern, $.struct_pattern),
    // An omitted element is an anonymous comma, preserving positional holes.
    tuple_pattern: $ => seq('[', repeat(seq(optional(field('element', $.pattern)), ',')), optional(field('element', $.pattern)), ']'),
    struct_pattern: $ => seq('{', commaSep(field('field', $.field_pattern)), '}'),
    field_pattern: $ => seq(field('name', $.identifier), optional(seq(':', field('pattern', $.pattern)))),

    _expression_sequence: $ => choice($.expression, $.sequence_expression),
    sequence_expression: $ => seq(field('expression', $.expression), repeat1(seq(',', field('expression', $.expression)))),
    expression: $ => choice(
      $.identifier, $.number_literal, $.string_literal, $.boolean_literal,
      $.parenthesized_expression, $.assignment_expression, $.conditional_expression,
      $.binary_expression, $.cast_expression, $.unary_expression, $.index_expression,
      $.member_expression, $.call_expression, $.generic_function, $.arrow_function,
      $.map_expression, $.fold_expression, $.slice_expression, $.tuple_literal,
      $.bytes_literal, $.struct_literal, $.assert_expression, $.disclose_expression,
      $.emit_expression, $.pad_expression, $.default_expression,
    ),
    parenthesized_expression: $ => seq('(', field('expression', $._expression_sequence), ')'),
    assignment_expression: $ => prec.right(1, seq(field('left', $.expression),
      field('operator', choice('=', '+=', '-=')), field('right', $.expression))),
    conditional_expression: $ => prec.right(1, seq(field('condition', $.expression), '?',
      field('consequence', $.expression), ':', field('alternative', $.expression))),
    binary_expression: $ => choice(...[
      ['||', 2], ['&&', 3], ['==', 4], ['!=', 4], ['<', 5], ['<=', 5], ['>=', 5], ['>', 5],
      ['+', 7], ['-', 7], ['*', 8],
    ].map(([op, p]) => prec.left(p, seq(field('left', $.expression), field('operator', op), field('right', $.expression))))),
    cast_expression: $ => prec.left(6, seq(field('value', $.expression), 'as', field('type', $.type))),
    unary_expression: $ => prec(9, seq(field('operator', '!'), field('argument', $.expression))),
    index_expression: $ => prec.left(10, seq(field('object', $.expression), '[', field('index', $.expression), ']')),
    member_expression: $ => prec.left(10, seq(field('object', $.expression), '.', field('property', $.identifier))),
    call_expression: $ => prec.left(10, seq(field('function', $.expression), field('args', $.argument_list))),
    generic_function: $ => seq(field('name', $.identifier), field('args', $.generic_arguments)),
    argument_list: $ => seq('(', commaSep(field('argument', $.expression)), ')'),
    arrow_function: $ => prec.right(seq(field('params', $.arrow_parameter_list),
      optional(seq(':', field('return_type', $.type))), '=>', field('body', choice($.block, $.expression)))),
    map_expression: $ => seq('map', '(', field('function', $.expression), ',', commaSep1(field('argument', $.expression)), optional(','), ')'),
    fold_expression: $ => seq('fold', '(', field('function', $.expression), ',', field('initial', $.expression), ',',
      commaSep1(field('argument', $.expression)), optional(','), ')'),
    slice_expression: $ => seq('slice', '<', field('size', $._type_size), '>', '(', field('value', $.expression), ',', field('start', $.expression), ')'),
    tuple_literal: $ => seq('[', commaSep(field('element', choice($.expression, $.spread_element))), ']'),
    bytes_literal: $ => seq('Bytes', '[', commaSep(field('element', choice($.expression, $.spread_element))), ']'),
    spread_element: $ => seq('...', field('value', $.expression)),
    struct_literal: $ => seq(field('type', $.type_reference), '{',
      commaSep(field('field', choice($.field_initializer, $.spread_element, $.expression))), '}'),
    field_initializer: $ => seq(field('name', $.identifier), ':', field('value', $.expression)),
    assert_expression: $ => seq('assert', '(', field('condition', $.expression), ',', field('message', $.string_literal), ')'),
    disclose_expression: $ => seq('disclose', '(', field('value', $.expression), ')'),
    emit_expression: $ => seq('emit', '(', field('value', $.expression), ')'),
    pad_expression: $ => seq('pad', '(', field('size', $.number_literal), ',', field('value', $.string_literal), ')'),
    default_expression: $ => seq('default', '<', field('type', $.type), '>'),
    boolean_literal: _ => choice('true', 'false'),
    number_literal: _ => /0|[1-9][0-9]*/,
    string_literal: $ => choice(
      seq('"', repeat(choice(token.immediate(/[^"\\\r\n]+/), $.escape_sequence)), token.immediate('"')),
      seq("'", repeat(choice(token.immediate(/[^'\\\r\n]+/), $.escape_sequence)), token.immediate("'")),
    ),
    escape_sequence: _ => token.immediate(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|u\{[0-9a-fA-F]+\}|[^\r\nxu]|\r?\n|\r)/),
    identifier: _ => identifierPattern(),
    comment: _ => token(choice(seq('//', /[^\r\n]*/), seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/'))),
  },
});
