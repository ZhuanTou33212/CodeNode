/** TS/JS 语法结构提取。只解析，不做类型检查；其他语言由 RAG 的行级切块处理。 */
'use strict';

const path = require('path');
const ts = require('@typescript/typescript6');

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

function scriptKind(relative) {
  const ext = path.extname(relative).toLowerCase();
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function lineAt(sourceFile, position) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function spanOf(sourceFile, node) {
  const docs = /** @type {any} */ (node).jsDoc;
  const firstDoc = Array.isArray(docs) && docs.length ? docs[0] : null;
  const start = firstDoc && node.getStart(sourceFile) - firstDoc.pos < 4000
    ? firstDoc.pos : node.getStart(sourceFile);
  return {
    startLine: lineAt(sourceFile, start),
    endLine: lineAt(sourceFile, Math.max(node.getStart(sourceFile), node.getEnd() - 1)),
  };
}

function symbolName(node, fallback) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isVariableStatement(node)) {
    const first = node.declarationList.declarations[0];
    if (first && ts.isIdentifier(first.name)) return first.name.text;
  }
  return fallback || '';
}

function isExported(node) {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) || []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function callNames(node) {
  const calls = new Set();
  const visit = (child) => {
    if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
      const expression = child.expression;
      if (ts.isIdentifier(expression)) calls.add(expression.text);
      else if (ts.isPropertyAccessExpression(expression)) calls.add(expression.name.text);
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return [...calls].filter((name) => name.length >= 2).slice(0, 80);
}

function referenceNames(node) {
  const references = new Set();
  const visit = (child) => {
    if (ts.isIdentifier(child) && child.text.length >= 3) {
      const parent = child.parent;
      const declarationName = /** @type {any} */ (parent)?.name === child;
      const propertyName = parent && ts.isPropertyAccessExpression(parent) && parent.name === child;
      if (!declarationName && !propertyName) references.add(child.text);
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return [...references].slice(0, 150);
}

function importsOf(sourceFile) {
  const imports = new Set();
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' && node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])) imports.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return [...imports].filter((name) => name.startsWith('.')).slice(0, 200);
}

function isIndexedStatement(node) {
  if (ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) ||
      ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
      ts.isModuleDeclaration(node)) return true;
  if (ts.isVariableStatement(node)) {
    // Configuration tables and constants are first-class code evidence, even when private.
    // Grouping them into a large module chunk hides thresholds and feature defaults.
    return true;
  }
  return false;
}

function segmentFor(sourceFile, node, kind, parentSymbol, parentContext) {
  const span = spanOf(sourceFile, node);
  const name = symbolName(node, kind);
  const boundaries = new Set();
  const closures = [];
  const visit = (child) => {
    if (ts.isStatement(child)) boundaries.add(lineAt(sourceFile, child.getStart(sourceFile)));
    if ((ts.isFunctionDeclaration(child) || ts.isFunctionExpression(child) || ts.isArrowFunction(child)) && child !== node) {
      const closure = spanOf(sourceFile, child);
      closures.push({ ...closure, name: symbolName(child, 'closure'),
        signature: sourceFile.text.slice(child.getStart(sourceFile), child.body ? child.body.getStart(sourceFile) : child.getEnd()).slice(0, 800) });
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  const body = /** @type {any} */ (node).body;
  const signature = sourceFile.text.slice(node.getStart(sourceFile), body ? body.getStart(sourceFile) : Math.min(node.getEnd(), node.getStart(sourceFile) + 800)).slice(0, 800);
  return {
    ...span,
    kind,
    symbol: name,
    qualifiedSymbol: parentSymbol ? parentSymbol + '.' + name : name,
    parentSymbol: parentSymbol || '',
    parentContext: parentContext || null,
    signature,
    boundaries: [...boundaries].sort((a, b) => a - b),
    closures,
    aliases: /** @type {string[]} */ ([]),
    calls: callNames(node),
    references: referenceNames(node),
    exported: isExported(node),
  };
}

/** 返回覆盖文件的结构段；过长的段由调用方按行数继续细分。 */
function analyzeCode(relative, text) {
  if (!CODE_EXTENSIONS.has(path.extname(relative).toLowerCase())) return null;
  const source = String(text || '');
  const sourceFile = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, scriptKind(relative));
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const units = [];
  for (const node of sourceFile.statements) {
    const declaration = ts.isVariableStatement(node) && node.declarationList.declarations.length === 1 ? node.declarationList.declarations[0] : null;
    const initializer = declaration && declaration.initializer;
    const objectTable = initializer && ts.isObjectLiteralExpression(initializer) ? initializer :
      initializer && ts.isCallExpression(initializer) && initializer.expression.getText(sourceFile) === 'Object.freeze' &&
        initializer.arguments.length === 1 && ts.isObjectLiteralExpression(initializer.arguments[0]) ? initializer.arguments[0] : null;
    if (objectTable && spanOf(sourceFile, node).endLine > spanOf(sourceFile, node).startLine &&
        objectTable.properties.every((part) => ts.isPropertyAssignment(part) && !ts.isComputedPropertyName(part.name)) &&
        (!objectTable.properties.length || lineAt(sourceFile, objectTable.properties[0].getStart(sourceFile)) > spanOf(sourceFile, node).startLine) &&
        objectTable.properties.every((part, index) => index === 0 || spanOf(sourceFile, objectTable.properties[index - 1]).endLine < spanOf(sourceFile, part).startLine)) {
      const name = symbolName(node, 'object');
      const span = spanOf(sourceFile, node);
      const first = objectTable.properties[0];
      if (!first) { units.push(segmentFor(sourceFile, node, 'variable', '', null)); continue; }
      const headerEnd = lineAt(sourceFile, first.getStart(sourceFile)) - 1;
      const parentContext = headerEnd >= span.startLine ? { startLine: span.startLine, endLine: headerEnd,
        content: lines.slice(span.startLine - 1, headerEnd).join('\n').trimEnd() } : null;
      if (parentContext) units.push({ ...segmentFor(sourceFile, node, 'variable', '', null), endLine: headerEnd,
        calls: [], references: [] });
      for (const property of objectTable.properties) {
        const segment = segmentFor(sourceFile, property, 'property', name, parentContext);
        if (property.name && ts.isStringLiteral(property.name)) {
          segment.symbol = property.name.text;
          segment.qualifiedSymbol = name + '.' + property.name.text;
        }
        units.push(segment);
      }
    } else if (ts.isClassDeclaration(node)) {
      const className = symbolName(node, 'class');
      const classSpan = spanOf(sourceFile, node);
      const members = node.members.filter((member) =>
        ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member));
      if (!members.length) {
        units.push(segmentFor(sourceFile, node, 'class', '', null));
        continue;
      }
      if (classSpan.startLine === classSpan.endLine) {
        const singleLine = segmentFor(sourceFile, node, 'class', '', null);
        singleLine.aliases = members.map((member) => symbolName(member, '')).filter(Boolean);
        units.push(singleLine);
        continue;
      }
      const firstMember = spanOf(sourceFile, members[0]);
      const headerEnd = firstMember.startLine - 1;
      const parentContext = {
        startLine: classSpan.startLine,
        endLine: Math.max(classSpan.startLine, Math.min(headerEnd, classSpan.startLine + 5)),
        content: lines.slice(classSpan.startLine - 1, Math.max(classSpan.startLine, Math.min(headerEnd, classSpan.startLine + 5))).join('\n').trimEnd(),
      };
      if (headerEnd >= classSpan.startLine) {
        units.push({
          startLine: classSpan.startLine, endLine: headerEnd, kind: 'class',
          symbol: className, qualifiedSymbol: className, parentSymbol: '', aliases: [],
          parentContext: null, calls: [], references: [],
          exported: isExported(node),
        });
      }
      for (let i = 0; i < members.length; i++) {
        const segment = segmentFor(sourceFile, members[i], 'method', className, parentContext);
        if (i === 0 && headerEnd < classSpan.startLine) segment.aliases = [className];
        units.push(segment);
      }
    } else if (isIndexedStatement(node)) {
      const kind = ts.isFunctionDeclaration(node) ? 'function' :
        ts.isInterfaceDeclaration(node) ? 'interface' :
          ts.isTypeAliasDeclaration(node) ? 'type' :
            ts.isEnumDeclaration(node) ? 'enum' :
              ts.isModuleDeclaration(node) ? 'module' : 'variable';
      units.push(segmentFor(sourceFile, node, kind, '', null));
    }
  }
  units.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const segments = [];
  let nextLine = 1;
  for (const unit of units) {
    if (unit.endLine < nextLine) continue;
    if (unit.startLine > nextLine) {
      segments.push({ startLine: nextLine, endLine: unit.startLine - 1, kind: 'module',
        symbol: '', qualifiedSymbol: '', parentSymbol: '', aliases: [], parentContext: null, calls: [], references: [], exported: false });
    }
    segments.push({ ...unit, startLine: Math.max(unit.startLine, nextLine) });
    nextLine = unit.endLine + 1;
  }
  if (nextLine <= lines.length) {
    segments.push({ startLine: nextLine, endLine: lines.length, kind: 'module',
      symbol: '', qualifiedSymbol: '', parentSymbol: '', aliases: [], parentContext: null, calls: [], references: [], exported: false });
  }
  return { segments, imports: importsOf(sourceFile),
    navigation: require('./symbolNavigation.cjs').extractNavigation(sourceFile) };
}

module.exports = { analyzeCode, CODE_EXTENSIONS };
