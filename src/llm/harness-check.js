import ts from 'typescript';

// Accepts an LLM answer only if it parses as JavaScript and uses only the
// playground API. The user's own code gets a looser check (own: true): it runs
// in their own tab, so it only needs to keep away from the network and the
// like. Runs in src/llm/harness-check-worker.js, so a hostile answer cannot hold
// up the server.

const MAX_REFUSAL_LENGTH = 200;

// The documented API, minus page.cdp: raw CDP can do anything to the browser,
// so only the user's own code may use it.
const PAGE_METHODS = new Set([
  'goto',
  'url',
  'title',
  'content',
  'click',
  'fill',
  'press',
  'evaluate',
  '$eval',
  '$$eval',
  'textContent',
  'innerText',
  'waitForSelector',
  'waitForTimeout'
]);
const CONSOLE_METHODS = new Set(['log', 'info', 'warn', 'error']);
// Which argument runs inside the browser's page, not in the worker.
const PAGE_FUNCTION_ARGUMENT = { evaluate: 0, $eval: 1, $$eval: 1 };
// Object and Reflect are left out: Object.getOwnPropertyDescriptor(x, 'constructor') reaches Function.
const SAFE_GLOBALS = new Set(['JSON', 'Math', 'Number', 'String', 'Boolean', 'Array', 'undefined', 'NaN']);
const RESERVED = new Set(['page', 'console', ...SAFE_GLOBALS]);

// Escapes and exfiltration: code evaluation, the network, storage, and
// navigation. Rejected as a name or a property, in the worker and the page.
const FORBIDDEN_NAMES = new Set([
  'constructor',
  '__proto__',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  'eval',
  'Function',
  'Reflect',
  'Proxy',
  'WebAssembly',
  'importScripts',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'RTCPeerConnection',
  'sendBeacon',
  'postMessage',
  'Worker',
  'SharedWorker',
  'serviceWorker',
  'cookie',
  'cookieStore',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'location',
  'open',
  'assign',
  'setAttribute',
  'setAttributeNS',
  'insertAdjacentHTML',
  'createElement',
  'write',
  'writeln'
]);

const K = ts.SyntaxKind;

// TypeScript parses more than JavaScript, so reject those forms here; the worker would fail on them anyway.
const TYPESCRIPT_ONLY = new Set([
  K.AsExpression,
  K.SatisfiesExpression,
  K.NonNullExpression,
  K.TypeAssertionExpression,
  K.ExpressionWithTypeArguments,
  K.Decorator,
  K.EnumDeclaration,
  K.InterfaceDeclaration,
  K.TypeAliasDeclaration,
  K.ModuleDeclaration,
  K.ImportEqualsDeclaration,
  K.TypeParameter,
  K.ImportDeclaration,
  K.ExportDeclaration,
  K.ExportAssignment
]);

const fail = (message) => {
  throw new Error(message);
};

const checkName = (name) => {
  if (FORBIDDEN_NAMES.has(name)) fail(`${name} is not allowed`);
};

const isAssignment = (token) => token.kind >= K.FirstAssignment && token.kind <= K.LastAssignment;
const isUpdate = (node) => node.operator === K.PlusPlusToken || node.operator === K.MinusMinusToken;
const isFunction = (node) => Boolean(node) && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

const checkSyntax = (node) => {
  if (ts.isTypeNode(node) || TYPESCRIPT_ONLY.has(node.kind)) fail(`${K[node.kind]} is not JavaScript`);
  if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind !== K.AsyncKeyword)) {
    fail('Modifiers are not allowed');
  }
  // A ternary also has a questionToken; it is allowed.
  if ((node.questionToken && !ts.isConditionalExpression(node)) || node.exclamationToken) {
    fail('Optional and definite markers are not JavaScript');
  }
  ts.forEachChild(node, checkSyntax);
};

// a[0] and a['key'] are fine; a[key] could spell out a forbidden name, so only
// the user's own code may do that.
const checkIndex = (argument, own) => {
  if (ts.isNumericLiteral(argument)) return;
  if (own) return;
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return checkName(argument.text);
  fail('Index only with a literal, e.g. items[0]; loop with for...of');
};

const propertyName = (name) => {
  if (ts.isComputedPropertyName(name) || ts.isPrivateIdentifier(name)) fail('Computed or private keys are not allowed');
  return name.text;
};

// Code in the page may read the DOM, but not touch forbidden names, and it
// cannot change elements: page.fill and page.click do that.
const checkPageCode = (node, own) => {
  if (ts.isIdentifier(node)) return checkName(node.text);
  if (ts.isPrivateIdentifier(node) || ts.isComputedPropertyName(node)) fail('Computed or private keys are not allowed');
  if (ts.isElementAccessExpression(node)) checkIndex(node.argumentExpression, own);
  if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken) && !ts.isIdentifier(node.left)) {
    fail('Code in the page may not change elements');
  }
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && isUpdate(node)) {
    if (!ts.isIdentifier(node.operand)) fail('Code in the page may not change elements');
  }
  if (ts.isDeleteExpression(node)) fail('Code in the page may not change elements');
  if (ts.isCallExpression(node)) {
    if (node.expression.kind === K.ImportKeyword) fail('import() is not allowed');
    // setTimeout('code') evaluates the string, so require a function.
    const callee = ts.isIdentifier(node.expression) ? node.expression.text : '';
    if ((callee === 'setTimeout' || callee === 'setInterval') && !isFunction(node.arguments[0])) {
      fail(`${callee} needs a function`);
    }
  }
  if (ts.isMetaProperty(node) || ts.isClassLike(node) || node.kind === K.WithStatement) {
    fail(`${K[node.kind]} is not allowed`);
  }
  ts.forEachChild(node, (child) => checkPageCode(child, own));
};

const declare = (name, names, check) => {
  if (ts.isIdentifier(name)) {
    checkName(name.text);
    if (RESERVED.has(name.text)) fail(`${name.text} cannot be redeclared`);
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (element.propertyName) checkName(propertyName(element.propertyName));
    declare(element.name, names, check);
    check(element.initializer);
  }
};

// The script's own code, in the worker: an allowlist of syntax, the names it
// declares, page and console calls, and a few safe globals.
const checkScript = (node, names, own) => {
  const check = (child) => child && checkScript(child, names, own);
  const declareAll = (name) => declare(name, names, check);

  if (ts.isBlock(node)) return node.statements.forEach(check);
  if (ts.isEmptyStatement(node) || ts.isNumericLiteral(node) || ts.isRegularExpressionLiteral(node)) return;
  if ([K.TrueKeyword, K.FalseKeyword, K.NullKeyword].includes(node.kind)) return;
  // A name in a string could still be looked up by some API.
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return checkName(node.text);
  if (ts.isTemplateExpression(node)) return node.templateSpans.forEach((span) => check(span.expression));
  if (
    ts.isExpressionStatement(node) ||
    ts.isReturnStatement(node) ||
    ts.isThrowStatement(node) ||
    ts.isAwaitExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isSpreadElement(node) ||
    ts.isTypeOfExpression(node) ||
    ts.isVoidExpression(node)
  ) {
    return check(node.expression);
  }
  if (ts.isVariableStatement(node)) return check(node.declarationList);
  if (ts.isVariableDeclarationList(node)) {
    if (!(node.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) fail('Use const or let');
    return node.declarations.forEach((declaration) => {
      declareAll(declaration.name);
      check(declaration.initializer);
    });
  }
  if (ts.isIfStatement(node)) return [node.expression, node.thenStatement, node.elseStatement].forEach(check);
  if (ts.isConditionalExpression(node)) return [node.condition, node.whenTrue, node.whenFalse].forEach(check);
  if (ts.isForOfStatement(node)) {
    if (node.awaitModifier) fail('for await is not allowed');
    return [node.initializer, node.expression, node.statement].forEach(check);
  }
  // A loop that never ends only holds up the worker, and Stop ends that.
  if (ts.isForStatement(node))
    return [node.initializer, node.condition, node.incrementor, node.statement].forEach(check);
  if (ts.isForInStatement(node)) return [node.initializer, node.expression, node.statement].forEach(check);
  if (ts.isWhileStatement(node) || ts.isDoStatement(node)) return [node.expression, node.statement].forEach(check);
  if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
    if (node.label) fail('Labels are not allowed');
    return;
  }
  if (ts.isTryStatement(node)) {
    if (node.catchClause?.variableDeclaration) declareAll(node.catchClause.variableDeclaration.name);
    return [node.tryBlock, node.catchClause?.block, node.finallyBlock].forEach(check);
  }
  if (ts.isArrowFunction(node)) {
    node.parameters.forEach((parameter) => {
      declareAll(parameter.name);
      check(parameter.initializer);
    });
    return check(node.body);
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === K.CommaToken) fail('The comma operator is not allowed');
    if (isAssignment(node.operatorToken)) {
      if (!ts.isIdentifier(node.left) || !names.has(node.left.text)) fail('Only declared variables can be changed');
      return check(node.right);
    }
    return [node.left, node.right].forEach(check);
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    if (isUpdate(node) && (!ts.isIdentifier(node.operand) || !names.has(node.operand.text))) {
      fail('Only declared variables can be changed');
    }
    return check(node.operand);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.forEach((element) => !ts.isOmittedExpression(element) && check(element));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.forEach((property) => {
      if (ts.isSpreadAssignment(property)) return check(property.expression);
      if (ts.isShorthandPropertyAssignment(property)) return check(property.name);
      if (!ts.isPropertyAssignment(property)) fail('Only plain object properties');
      checkName(propertyName(property.name));
      check(property.initializer);
    });
  }
  if (ts.isNewExpression(node)) {
    if (!ts.isIdentifier(node.expression) || node.expression.text !== 'Error') fail('Only new Error() is allowed');
    return node.arguments?.forEach(check);
  }
  if (ts.isIdentifier(node)) {
    if (node.text === 'page' || node.text === 'console') fail(`Use ${node.text} only to call its methods`);
    checkName(node.text);
    if (!names.has(node.text) && !SAFE_GLOBALS.has(node.text)) fail(`${node.text} is not defined`);
    return;
  }
  if (ts.isPropertyAccessExpression(node)) {
    checkName(propertyName(node.name));
    return check(node.expression);
  }
  if (ts.isElementAccessExpression(node)) {
    checkIndex(node.argumentExpression, own);
    check(node.argumentExpression);
    return check(node.expression);
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const target =
      ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression.text : '';
    if (target === 'page' || target === 'console') {
      const method = propertyName(callee.name);
      const allowed = target === 'page' ? PAGE_METHODS : CONSOLE_METHODS;
      const ownCdp = own && target === 'page' && method === 'cdp';
      if (!allowed.has(method) && !ownCdp) fail(`${target}.${method} is not part of the playground API`);
      return node.arguments.forEach((argument, index) => {
        if (target === 'page' && PAGE_FUNCTION_ARGUMENT[method] === index) {
          if (!isFunction(argument)) fail(`page.${method} needs a function, not a string`);
          return checkPageCode(argument, own);
        }
        check(argument);
      });
    }
    check(callee);
    return node.arguments.forEach(check);
  }
  fail(`${K[node.kind]} is not allowed`);
};

// Models wrap code in a Markdown fence even when told not to; unwrap one fence
// around the whole answer, and let any prose around it fail to parse.
const unwrapFence = (answer) => {
  const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(answer.trim());
  return (fenced ? fenced[1] : answer).trim();
};

// What the model answers when it will not or cannot help.
const refusalOf = (statements) => {
  const [statement] = statements;
  if (statements.length !== 1 || !ts.isThrowStatement(statement) || !ts.isNewExpression(statement.expression)) {
    return null;
  }
  const message = statement.expression.arguments?.[0];
  if (!message || !(ts.isStringLiteral(message) || ts.isNoSubstitutionTemplateLiteral(message))) return null;
  return message.text.slice(0, MAX_REFUSAL_LENGTH);
};

// The same wrapper the playground worker gives the code: the body of an async function.
const PREFIX = '(async () => {\n';
const SUFFIX = '\n});';

/**
 * Checks the model's answer, or with own, the user's own code. Returns the
 * code, the model's refusal, or why the answer is not acceptable.
 * @param {string} answer
 * @param {{own?: boolean}} [options]
 * @returns {{data?: string, refusal?: string, error?: string}}
 */
const validateCode = (answer, { own = false } = {}) => {
  const code = unwrapFence(String(answer));
  if (!code) return { error: 'The answer is empty' };
  const source = PREFIX + code + SUFFIX;
  const { diagnostics = [] } = ts.transpileModule(source, {
    reportDiagnostics: true,
    fileName: 'script.ts',
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  });
  if (diagnostics.length > 0) {
    return {
      error: `The answer is not valid JavaScript: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, ' ')}`
    };
  }
  const file = ts.createSourceFile('script.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  // Code like `}); fetch(x); (async () => {` would close the wrapper early.
  const [statement] = file.statements;
  const wrapper =
    file.statements.length === 1 &&
    ts.isExpressionStatement(statement) &&
    ts.isParenthesizedExpression(statement.expression) &&
    ts.isArrowFunction(statement.expression.expression)
      ? statement.expression.expression
      : null;
  if (!wrapper || !ts.isBlock(wrapper.body) || wrapper.body.end !== source.length - SUFFIX.length + 2) {
    return { error: 'The answer must be the body of one function' };
  }
  const { statements } = wrapper.body;
  const refusal = refusalOf(statements);
  if (refusal) return { refusal };
  try {
    statements.forEach(checkSyntax);
    const names = new Set();
    statements.forEach((child) => checkScript(child, names, own));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { data: code };
};

export { validateCode };
