'use strict';

// Navigation uses the same parsed TS/JS source as RAG, but keeps exact AST
// locations rather than chunk boundaries. This is a static candidate index,
// not a type checker: unresolved receivers and dynamic dispatch stay explicit.
const { resolveImport } = require('./codeGraph.cjs');

function extractNavigation(sourceFile) {
  const ts = require('@typescript/typescript6');
  const definitions = [], references = [], imports = [];
  const declarationNames = new Set();
  const commonExports = new Set();
  const owners = new Map();
  const scopes = new Map();
  const location = (node) => {
    const start = node.getStart(sourceFile), end = node.getEnd();
    const a = sourceFile.getLineAndCharacterOfPosition(start);
    const b = sourceFile.getLineAndCharacterOfPosition(Math.max(start, end - 1));
    return { start, end, startLine: a.line + 1, endLine: b.line + 1, column: a.character + 1 };
  };
  const nameOf = (node) => node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : '';
  const scopeOf = (node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isFunctionLike(parent) || ts.isClassLike(parent)) return parent;
    }
    return sourceFile;
  };
  const add = (node, nameNode, kind, owner, scope) => {
    const symbol = nameOf(nameNode);
    if (!symbol) return null;
    declarationNames.add(nameNode);
    const span = location(node), binding = scope === sourceFile ? { start: 0, end: sourceFile.end } : location(scope);
    const qualifiedSymbol = owner ? owner.qualifiedSymbol + '.' + symbol : symbol;
    const definition = { ...span, id: sourceFile.fileName + ':' + nameNode.getStart(sourceFile),
      symbol, qualifiedSymbol, kind, scopeStart: binding.start, scopeEnd: binding.end,
      exported: hasModifier(node, ts.SyntaxKind.ExportKeyword), defaultExport: hasModifier(node, ts.SyntaxKind.DefaultKeyword) };
    definitions.push(definition);
    return definition;
  };
  function hasModifier(node, kind) {
    const declaration = ts.isVariableDeclaration(node) ? node.parent.parent : node;
    return !!(ts.canHaveModifiers(declaration) && (ts.getModifiers(declaration) || []).some((modifier) => modifier.kind === kind));
  }
  const bindings = (name, node, kind, owner, scope) => {
    if (ts.isIdentifier(name)) return add(node, name, kind, owner, scope);
    for (const part of name.elements || []) if (ts.isBindingElement(part)) {
      if (part.propertyName) declarationNames.add(part.propertyName);
      bindings(part.name, part, kind, owner, scope);
    }
    return null;
  };
  const collect = (node, owner) => {
    let nextOwner = owner;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.name) {
        declarationNames.add(clause.name);
        imports.push({ local: clause.name.text, imported: 'default', specifier: node.moduleSpecifier.text });
      }
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        declarationNames.add(named.name);
        imports.push({ local: named.name.text, imported: '*', specifier: node.moduleSpecifier.text });
      } else if (named && ts.isNamedImports(named)) for (const element of named.elements) {
        declarationNames.add(element.name);
        if (element.propertyName) declarationNames.add(element.propertyName);
        imports.push({ local: element.name.text, imported: (element.propertyName || element.name).text, specifier: node.moduleSpecifier.text });
      }
    }
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      const kind = ts.isFunctionDeclaration(node) ? 'function' : ts.isClassDeclaration(node) ? 'class' : 'type';
      nextOwner = add(node, node.name, kind, owner, scopeOf(node)) || owner;
    } else if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      nextOwner = add(node, node.name, 'method', owner, scopeOf(node)) || owner;
    } else if (ts.isVariableDeclaration(node)) {
      const initializer = node.initializer;
      const requireCall = initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === 'require' && initializer.arguments.length === 1 && ts.isStringLiteral(initializer.arguments[0]);
      const callable = node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
      const definition = bindings(node.name, node, requireCall ? 'import' : callable ? 'function' : 'variable', owner, scopeOf(node));
      if (requireCall) {
        const specifier = /** @type {any} */ (initializer.arguments[0]).text;
        const bindingScope = scopeOf(node) === sourceFile ? { start: 0, end: sourceFile.end } : location(scopeOf(node));
        if (ts.isIdentifier(node.name)) imports.push({ local: node.name.text, imported: '*', specifier, scopeStart: bindingScope.start, scopeEnd: bindingScope.end });
        else if (ts.isObjectBindingPattern(node.name)) for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)) imports.push({ local: element.name.text,
            imported: nameOf(element.propertyName || element.name), specifier, scopeStart: bindingScope.start, scopeEnd: bindingScope.end });
        }
      }
      if (callable && definition) owners.set(node.initializer, definition);
    } else if (ts.isParameter(node)) {
      bindings(node.name, node, 'parameter', owner, scopeOf(node));
    }
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !owners.has(node)) {
      const span = location(node);
      const symbol = '<anonymous@' + span.startLine + ':' + span.column + '>';
      const definition = { ...span, id: sourceFile.fileName + ':' + span.start + ':anonymous', symbol,
        qualifiedSymbol: owner ? owner.qualifiedSymbol + '.' + symbol : symbol, kind: 'function',
        scopeStart: span.start, scopeEnd: span.end, exported: false, defaultExport: false };
      definitions.push(definition); owners.set(node, definition);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left.getText(sourceFile);
      if (left === 'module.exports' && ts.isObjectLiteralExpression(node.right)) {
        for (const property of node.right.properties) {
          if (ts.isShorthandPropertyAssignment(property)) commonExports.add(property.name.text);
          else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer) && nameOf(property.name) === property.initializer.text) commonExports.add(property.initializer.text);
        }
      } else if (/^(?:module\.)?exports\.[A-Za-z_$][\w$]*$/.test(left) && ts.isIdentifier(node.right) && left.split('.').at(-1) === node.right.text) commonExports.add(node.right.text);
    }
    if (owners.has(node)) nextOwner = owners.get(node);
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
      if (nextOwner) owners.set(node, nextOwner);
    }
    scopes.set(node, nextOwner);
    ts.forEachChild(node, (child) => collect(child, nextOwner));
  };
  collect(sourceFile, null);
  for (const definition of definitions) if (definition.scopeStart === 0 && commonExports.has(definition.symbol)) definition.exported = true;
  const visit = (node) => {
    if (ts.isIdentifier(node) && !declarationNames.has(node)) {
      const parent = node.parent;
      const namedDeclaration = /** @type {any} */ (parent).name === node && !ts.isShorthandPropertyAssignment(parent) && !ts.isPropertyAccessExpression(parent);
      const inImport = ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent);
      if (!namedDeclaration && !inImport && !ts.isExportSpecifier(parent)) {
        const property = ts.isPropertyAccessExpression(parent) && parent.name === node;
        const expression = property ? parent : node;
        const call = expression.parent && (ts.isCallExpression(expression.parent) || ts.isNewExpression(expression.parent)) && expression.parent.expression === expression;
        const owner = scopes.get(node);
        references.push({ ...location(node), symbol: node.text, kind: call ? 'call' : 'reference',
          receiver: property ? parent.expression.getText(sourceFile) : '', ownerId: owner?.id || null });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { definitions, references, imports, parseErrors: /** @type {any} */ (sourceFile).parseDiagnostics?.length || 0 };
}

function queryNavigation(fileCache, operation, args) {
  const files = new Set(fileCache.keys());
  const definitions = [], sites = [];
  for (const [path, entry] of fileCache) {
    if (!entry.navigation) continue;
    for (const definition of entry.navigation.definitions) definitions.push({ ...definition, path, sourceSha256: entry.sourceSha256 });
    for (const site of entry.navigation.references) sites.push({ ...site, path, sourceSha256: entry.sourceSha256 });
  }
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const byFile = new Map();
  const methodsByName = new Map();
  for (const definition of definitions) {
    if (!byFile.has(definition.path)) byFile.set(definition.path, []);
    byFile.get(definition.path).push(definition);
    if (definition.kind === 'method') {
      if (!methodsByName.has(definition.symbol)) methodsByName.set(definition.symbol, []);
      methodsByName.get(definition.symbol).push(definition);
    }
  }
  const publicDefinition = (definition) => ({ id: definition.id, path: definition.path, symbol: definition.symbol,
    qualifiedSymbol: definition.qualifiedSymbol, kind: definition.kind, startLine: definition.startLine,
    endLine: definition.endLine, column: definition.column, sourceSha256: definition.sourceSha256 });
  const matches = (definition) => (definition.symbol === args.symbol || definition.qualifiedSymbol === args.symbol) &&
    (!args.path || definition.path === args.path || definition.path.startsWith(args.path + '/')) &&
    (!args.line || (definition.startLine <= args.line && definition.endLine >= args.line));
  let selected = definitions.filter(matches);
  // A line inside a method also falls inside its class/function: choose the
  // smallest matching range, retaining overloads/duplicates as candidates.
  if (args.line && selected.length) {
    const width = Math.min(...selected.map((definition) => definition.end - definition.start));
    selected = selected.filter((definition) => definition.end - definition.start === width);
  }
  const selectedIds = new Set(selected.map((definition) => definition.id));
  const resolve = (site) => {
    const local = byFile.get(site.path) || [];
    const entry = fileCache.get(site.path);
    const bindings = entry.navigation.imports;
    let candidates = [], resolution = 'unresolved';
    if (!site.receiver) {
      candidates = local.filter((definition) => definition.symbol === site.symbol && definition.kind !== 'method' && definition.kind !== 'import' &&
        definition.scopeStart <= site.start && definition.scopeEnd >= site.end);
      if (candidates.length) {
        const width = Math.min(...candidates.map((definition) => definition.scopeEnd - definition.scopeStart));
        candidates = candidates.filter((definition) => definition.scopeEnd - definition.scopeStart === width);
        resolution = 'lexical';
      } else {
        const binding = bindings.find((item) => item.local === site.symbol && item.imported !== '*' &&
          (item.scopeStart == null || (item.scopeStart <= site.start && item.scopeEnd >= site.end)));
        if (binding) {
          const target = resolveImport(site.path, binding.specifier, files);
          candidates = (byFile.get(target) || []).filter((definition) => definition.scopeStart === 0 &&
            (binding.imported === 'default' ? definition.defaultExport : definition.exported && definition.symbol === binding.imported));
          resolution = candidates.length ? 'import' : 'unresolved';
        }
      }
    } else {
      const shadowed = local.some((definition) => definition.symbol === site.receiver && definition.kind !== 'import' &&
        definition.scopeStart <= site.start && definition.scopeEnd >= site.end);
      const binding = !shadowed && bindings.find((item) => item.local === site.receiver && item.imported === '*' &&
        (item.scopeStart == null || (item.scopeStart <= site.start && item.scopeEnd >= site.end)));
      if (binding) {
        const target = resolveImport(site.path, binding.specifier, files);
        candidates = (byFile.get(target) || []).filter((definition) => definition.scopeStart === 0 && definition.exported && definition.symbol === site.symbol);
        resolution = candidates.length ? 'import' : 'unresolved';
      } else if (site.receiver === 'this') {
        const owner = byId.get(site.ownerId);
        const prefix = owner?.qualifiedSymbol.split('.').slice(0, -1).join('.');
        if (prefix) candidates = local.filter((definition) => definition.qualifiedSymbol === prefix + '.' + site.symbol);
        resolution = candidates.length ? 'member-candidate' : 'unresolved';
      } else {
        // An unknown receiver must never be promoted to a unique type binding.
        candidates = methodsByName.get(site.symbol) || [];
        resolution = candidates.length ? 'name-only' : 'unresolved';
      }
    }
    return { candidates, resolution };
  };
  /** @type {any[]} */
  let results;
  if (operation === 'find_definition') {
    results = selected.map(publicDefinition);
  } else {
    results = [];
    for (const site of sites) {
      if (operation !== 'find_references' && site.kind !== 'call') continue;
      if (operation === 'get_callees' && !selectedIds.has(site.ownerId)) continue;
      const resolved = resolve(site);
      if (operation !== 'get_callees' && !resolved.candidates.some((definition) => selectedIds.has(definition.id))) continue;
      results.push({ path: site.path, symbol: site.symbol, startLine: site.startLine, endLine: site.endLine,
        column: site.column, kind: site.kind, receiver: site.receiver, sourceSha256: site.sourceSha256,
        owner: byId.has(site.ownerId) ? publicDefinition(byId.get(site.ownerId)) : null,
        candidates: resolved.candidates.slice(0, 20).map(publicDefinition), candidateCount: resolved.candidates.length, resolution: resolved.resolution,
        ambiguous: resolved.candidates.length !== 1 || resolved.resolution === 'name-only' || resolved.resolution === 'member-candidate' });
    }
  }
  results.sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine || a.column - b.column);
  const offset = args.offset || 0, max = args.maxResults || 40;
  const visibleDefinitions = selected.slice(0, 20).map(publicDefinition);
  while (visibleDefinitions.length > 1 && JSON.stringify(visibleDefinitions).length > 8000) visibleDefinitions.pop();
  const visible = [];
  let chars = 0;
  for (const result of results.slice(offset, offset + max)) {
    if (result.candidates) while (result.candidates.length && JSON.stringify(result).length > 12000) result.candidates.pop();
    const size = JSON.stringify(result).length;
    if (visible.length && chars + size > 24000) break;
    visible.push(result); chars += size;
  }
  const sourceVersions = {};
  const addVersion = (location) => { if (location) sourceVersions[location.path] = location.sourceSha256; };
  for (const definition of visibleDefinitions) addVersion(definition);
  for (const result of visible) {
    addVersion(result);
    for (const candidate of result.candidates || []) addVersion(candidate);
    addVersion(result.owner);
  }
  return { operation, symbol: args.symbol, definitions: visibleDefinitions,
    definitionCount: selected.length, definitionsTruncated: selected.length > visibleDefinitions.length, results: visible,
    count: results.length, offset, nextOffset: offset + visible.length < results.length ? offset + visible.length : null,
    ambiguous: selected.length > 1 || visible.some((result) => result.ambiguous), approximate: true, sourceVersions };
}

module.exports = { extractNavigation, queryNavigation };
