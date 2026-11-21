import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const PYTHON_HELPER = join(fileURLToPath(new URL('.', import.meta.url)), 'discipline-python-comments.py');
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.jsonc']);
const CONFIG_EXTENSIONS = new Set(['.conf', '.cfg', '.ini', '.env', '.properties', '.toml']);
const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.jj', '.hg', '.svn', '.hive', '.cache', '.next', '.nuxt', '.turbo', '.parcel-cache',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'venv', '__pycache__', 'node_modules',
  'bower_components', 'vendor', 'dist', 'build', 'out', 'coverage', 'target', 'tmp', 'temp',
]);
const EXCLUDED_FILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Cargo.lock', 'composer.lock', 'Gemfile.lock', 'go.sum',
]);
const VCS_FILES = new Set(['.gitignore', '.gitattributes', '.gitmodules']);
const FENCE_LANGUAGES = new Map(Object.entries({
  ts: 'ts', typescript: 'ts', tsx: 'tsx', js: 'js', javascript: 'js', jsx: 'jsx', mjs: 'mjs',
  cjs: 'cjs', jsonc: 'jsonc', py: 'py', python: 'py', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh',
  yaml: 'yaml', yml: 'yaml', css: 'css', html: 'html', htm: 'html', dockerfile: 'dockerfile',
  ini: 'ini', conf: 'conf', cfg: 'cfg', toml: 'toml', properties: 'properties', env: 'env',
  hcl: 'hcl', terraform: 'hcl', tf: 'hcl',
}));

function lineIndex(source, firstLine) {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return (position) => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const middle = (low + high) >> 1;
      if (starts[middle] <= position) low = middle;
      else high = middle;
    }
    return firstLine + low;
  };
}

function addRange(lines, at, start, end) {
  const first = at(start);
  const last = at(Math.max(start, end - 1));
  for (let line = first; line <= last; line++) lines.add(line);
}

function scanTypeScript(source, firstLine, kind) {
  const lines = new Set();
  const at = lineIndex(source, firstLine);
  const scriptKinds = {
    ts: ts.ScriptKind.TS, tsx: ts.ScriptKind.TSX, js: ts.ScriptKind.JS, jsx: ts.ScriptKind.JSX,
    mjs: ts.ScriptKind.JS, cjs: ts.ScriptKind.JS, mts: ts.ScriptKind.TS, cts: ts.ScriptKind.TS,
    jsonc: ts.ScriptKind.JSON,
  };
  const sourceFile = ts.createSourceFile(`comments.${kind}`, source, ts.ScriptTarget.Latest, true, scriptKinds[kind]);
  const masked = source.split('');
  const maskedKinds = new Set([
    ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.RegularExpressionLiteral,
    ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail, ts.SyntaxKind.JsxText,
  ]);
  const collect = (ranges) => {
    for (const range of ranges ?? []) addRange(lines, at, range.pos, range.end);
  };
  const visit = (node) => {
    collect(ts.getLeadingCommentRanges(source, node.pos));
    collect(ts.getTrailingCommentRanges(source, node.end));
    if (maskedKinds.has(node.kind)) {
      for (let index = node.getStart(sourceFile); index < node.end; index++) {
        if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  collect(ts.getLeadingCommentRanges(source, sourceFile.end));
  for (let index = 0; index < masked.length; index++) {
    if (masked[index] !== '/' || (masked[index + 1] !== '/' && masked[index + 1] !== '*')) continue;
    const start = index;
    const multiline = masked[index + 1] === '*';
    index += 2;
    while (index < masked.length) {
      if (!multiline && (masked[index] === '\n' || masked[index] === '\r')) break;
      if (multiline && masked[index] === '*' && masked[index + 1] === '/') {
        index += 2;
        break;
      }
      index++;
    }
    addRange(lines, at, start, index);
  }
  return lines;
}

function scanPython(source, firstLine) {
  const result = spawnSync('python3', [PYTHON_HELPER, String(firstLine)], {
    input: source, encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'python tokenize failed');
  return new Set(JSON.parse(result.stdout));
}

function heredocDelimiter(line, start) {
  let index = start + 2;
  let stripTabs = false;
  if (line[index] === '<') return null;
  if (line[index] === '-') {
    stripTabs = true;
    index++;
  }
  while (line[index] === ' ' || line[index] === '\t') index++;
  let value = '';
  let quote = '';
  for (; index < line.length; index++) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = '';
      else value += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '\\') {
      if (index + 1 < line.length) value += line[++index];
      continue;
    }
    if (/[\s;&|()<>]/.test(character)) break;
    value += character;
  }
  return value ? { delimiter: value, stripTabs } : null;
}

function scanShell(source, firstLine) {
  const comments = new Set();
  const sourceLines = source.split('\n');
  let quote = '';
  let arithmetic = 0;
  let active = null;
  const pending = [];
  for (let offset = 0; offset < sourceLines.length; offset++) {
    const text = sourceLines[offset];
    const line = firstLine + offset;
    if (active) {
      const candidate = active.stripTabs ? text.replace(/^\t+/, '') : text;
      if (candidate === active.delimiter) active = pending.shift() ?? null;
      continue;
    }
    let boundary = true;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (quote === "'") {
        if (character === "'") quote = '';
        boundary = false;
        continue;
      }
      if (quote === '"') {
        if (character === '\\') index++;
        else if (character === '"') quote = '';
        boundary = false;
        continue;
      }
      if (character === '\\') {
        index++;
        boundary = false;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        boundary = false;
        continue;
      }
      if (arithmetic > 0) {
        if (character === '(') arithmetic++;
        else if (character === ')') arithmetic--;
        boundary = /[\s;&|()]/.test(character);
        continue;
      }
      const arithmeticStart = character === '$' && text.startsWith('((', index + 1) ? 3
        : character === '(' && text[index + 1] === '(' ? 2 : 0;
      if (arithmeticStart) {
        arithmetic = 2;
        index += arithmeticStart - 1;
        boundary = false;
        continue;
      }
      if (character === '#' && boundary) {
        if (!(offset === 0 && text.startsWith('#!'))) comments.add(line);
        break;
      }
      if (character === '<' && text[index + 1] === '<' && text[index - 1] !== '<') {
        const item = heredocDelimiter(text, index);
        if (item) {
          pending.push({ ...item, line });
          index += 2;
          while (index < text.length && !/[\s;&|()]/.test(text[index])) index++;
          index--;
          boundary = false;
          continue;
        }
      }
      boundary = /[\s;&|()]/.test(character);
    }
    if (!quote && !active && pending.length) active = pending.shift();
  }
  if (active || pending.length) throw new Error('unterminated heredoc');
  return comments;
}

function scanHcl(source, firstLine) {
  const comments = new Set();
  const sourceLines = source.split('\n');
  let quote = false;
  let block = false;
  let active = null;
  const pending = [];
  for (let offset = 0; offset < sourceLines.length; offset++) {
    const text = sourceLines[offset];
    const line = firstLine + offset;
    if (active) {
      const candidate = active.stripTabs ? text.trimStart() : text;
      if (candidate === active.delimiter) active = pending.shift() ?? null;
      continue;
    }
    if (block) comments.add(line);
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      const next = text[index + 1];
      if (block) {
        if (character === '*' && next === '/') {
          block = false;
          index++;
        }
        continue;
      }
      if (quote) {
        if (character === '\\') index++;
        else if (character === '"') quote = false;
        continue;
      }
      if (character === '"') {
        quote = true;
        continue;
      }
      if (character === '/' && next === '*') {
        block = true;
        comments.add(line);
        index++;
        continue;
      }
      if (character === '#' || character === '/' && next === '/') {
        comments.add(line);
        break;
      }
      if (character === '<' && next === '<') {
        const item = heredocDelimiter(text, index);
        if (item) {
          pending.push(item);
          index += 2;
          while (index < text.length && !/[\s;,{}()[\]]/.test(text[index])) index++;
          index--;
        }
      }
    }
    if (!quote && !block && !active && pending.length) active = pending.shift();
  }
  return comments;
}

function scanYaml(source, firstLine) {
  const comments = new Set();
  const sourceLines = source.split('\n');
  let quote = '';
  let scalarIndent = null;
  for (let offset = 0; offset < sourceLines.length; offset++) {
    const text = sourceLines[offset];
    const line = firstLine + offset;
    const indent = text.match(/^ */)[0].length;
    if (scalarIndent !== null) {
      if (!text.trim() || indent > scalarIndent) continue;
      scalarIndent = null;
    }
    let commentAt = text.length;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (quote === "'") {
        if (character === "'" && text[index + 1] === "'") index++;
        else if (character === "'") quote = '';
        continue;
      }
      if (quote === '"') {
        if (character === '\\') index++;
        else if (character === '"') quote = '';
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }
      if (character === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
        commentAt = index;
        comments.add(line);
        break;
      }
    }
    const code = text.slice(0, commentAt).trimEnd();
    if (!quote && /(?:^|:\s*|-\s*)(?:(?:![^\s]+|&[^\s]+)\s+)*[|>](?:[1-9][+-]?|[+-][1-9]?)?$/.test(code)) scalarIndent = indent;
  }
  return comments;
}

function scanCss(source, firstLine) {
  const comments = new Set();
  let line = firstLine;
  let quote = '';
  let block = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (block) {
      if (character === '\n') {
        line++;
        comments.add(line);
      } else if (character === '*' && next === '/') {
        block = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = '';
      if (character === '\n') line++;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '/' && next === '*') {
      block = true;
      comments.add(line);
      index++;
      continue;
    }
    if (character === '\n') line++;
  }
  return comments;
}

function scanHtml(source, firstLine, markdown = false) {
  const comments = new Set();
  const lower = source.toLowerCase();
  let line = firstLine;
  let comment = false;
  let tag = false;
  let quote = '';
  let raw = '';
  let rawStart = 0;
  let rawLine = firstLine;
  let tagName = '';
  let closing = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (comment) {
      if (character === '\n') {
        line++;
        comments.add(line);
      }
      if (source.startsWith('-->', index)) {
        comment = false;
        index += 2;
      }
      continue;
    }
    if (raw) {
      const closingCharacter = lower[index + raw.length + 2];
      if (lower.startsWith(`</${raw}`, index) && closingCharacter && /[\s/>]/.test(closingCharacter)) {
        const embedded = source.slice(rawStart, index);
        const found = raw === 'script' ? scanTypeScript(embedded, rawLine, 'js') : scanCss(embedded, rawLine);
        for (const item of found) comments.add(item);
        raw = '';
        tag = true;
        closing = true;
        tagName = '';
      } else {
        if (character === '\n') line++;
        continue;
      }
    }
    if (quote) {
      if (character === quote) quote = '';
      if (character === '\n') line++;
      continue;
    }
    if (tag) {
      if (character === "'" || character === '"') quote = character;
      if (character === '>') {
        tag = false;
        if (!closing && (tagName === 'script' || tagName === 'style')) {
          raw = tagName;
          rawStart = index + 1;
          rawLine = line;
        }
      }
      if (character === '\n') line++;
      continue;
    }
    if (markdown && character === '`') {
      const end = inlineCodeSpanEnd(source, index);
      if (end >= 0) {
        for (let position = index; position < end; position++) {
          if (source[position] === '\n') line++;
        }
        index = end - 1;
        continue;
      }
    }
    if (source.startsWith('<!--', index)) {
      comment = true;
      comments.add(line);
      index += 3;
      continue;
    }
    if (character === '<') {
      const match = source.slice(index).match(/^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9-]*)/);
      if (match) {
        tag = true;
        closing = match[1] === '/';
        tagName = match[2].toLowerCase();
        continue;
      }
    }
    if (character === '\n') line++;
  }
  if (raw) throw new Error(`unterminated ${raw} raw-text region`);
  return comments;
}

function scanConfig(source, firstLine, kind) {
  const comments = new Set();
  const sourceLines = source.split('\n');
  let quote = '';
  let triple = false;
  for (let offset = 0; offset < sourceLines.length; offset++) {
    const text = sourceLines[offset];
    const line = firstLine + offset;
    if (kind === 'properties') {
      if (/^\s*[#!]/.test(text)) comments.add(line);
      continue;
    }
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (quote) {
        if (triple && text.startsWith(quote.repeat(3), index)) {
          quote = '';
          triple = false;
          index += 2;
        } else if (!triple && character === '\\' && quote === '"') index++;
        else if (!triple && character === quote) quote = '';
        continue;
      }
      if (kind === 'toml' && (text.startsWith("'''", index) || text.startsWith('"""', index))) {
        quote = character;
        triple = true;
        index += 2;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }
      const semicolon = kind === 'ini' && character === ';' && (index === 0 || /\s/.test(text[index - 1]));
      const hash = character === '#' && (kind === 'toml' || index === 0 || /\s/.test(text[index - 1]));
      if (hash || semicolon) {
        if (!(offset === 0 && text.startsWith('#!'))) comments.add(line);
        break;
      }
    }
    if (quote && !triple) quote = '';
  }
  return comments;
}

function inlineCodeSpanEnd(source, start) {
  let cursor = start;
  while (source[cursor] === '`') cursor++;
  const delimiterLength = cursor - start;
  while (cursor < source.length) {
    if (source[cursor] !== '`') {
      cursor++;
      continue;
    }
    const runStart = cursor;
    while (source[cursor] === '`') cursor++;
    if (cursor - runStart === delimiterLength) return cursor;
  }
  return -1;
}

function markdownContainer(text) {
  let normalized = text;
  const containers = [];
  for (;;) {
    const quote = normalized.match(/^ {0,3}>[ \t]?/);
    if (quote) {
      containers.push({ kind: 'quote' });
      normalized = normalized.slice(quote[0].length);
      continue;
    }
    const list = normalized.match(/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/);
    if (list) {
      containers.push({ kind: 'list', indent: list[0].length });
      normalized = normalized.slice(list[0].length);
      continue;
    }
    return { text: normalized, containers };
  }
}

function markdownContinuation(text, containers) {
  let normalized = text;
  for (const container of containers) {
    if (container.kind === 'quote') {
      const quote = normalized.match(/^ {0,3}>[ \t]?/);
      if (!quote) break;
      normalized = normalized.slice(quote[0].length);
    } else {
      const indent = Math.min(container.indent, normalized.match(/^ */)[0].length);
      normalized = normalized.slice(indent);
    }
  }
  return normalized;
}

function scanMarkdown(source, firstLine) {
  const comments = new Set();
  const sourceLines = source.split('\n');
  let fence = null;
  let content = [];
  let outside = [];
  let outsideFirst = firstLine;
  const collectOutside = () => {
    for (const line of scanHtml(outside.join('\n'), outsideFirst, true)) comments.add(line);
    outside = [];
  };
  for (let offset = 0; offset <= sourceLines.length; offset++) {
    const raw = sourceLines[offset] ?? '';
    if (fence) {
      const text = fence.containers.length ? markdownContinuation(raw, fence.containers) : raw;
      const closing = new RegExp(`^ {0,3}${fence.character}{${fence.length},}\\s*$`).test(text);
      if (closing || offset === sourceLines.length) {
        if (fence.kind) {
          for (const line of scanKind(fence.kind, content.join('\n'), fence.firstLine)) comments.add(line);
        }
        fence = null;
        content = [];
        outsideFirst = firstLine + offset + 1;
        continue;
      }
      content.push(text.slice(Math.min(fence.indent, text.match(/^ */)[0].length)));
      continue;
    }
    const container = markdownContainer(raw);
    const text = container.text;
    const match = text.match(/^( {0,3})(`{3,}|~{3,})[^\n]*$/);
    if (match) {
      collectOutside();
      const info = text.slice(match[0].indexOf(match[2]) + match[2].length).trim().split(/[\s,]/)[0].toLowerCase();
      fence = {
        character: match[2][0], length: match[2].length, indent: match[1].length,
        containers: container.containers, kind: FENCE_LANGUAGES.get(info) ?? null,
        firstLine: firstLine + offset + 1,
      };
      continue;
    }
    if (offset < sourceLines.length) outside.push(text);
  }
  collectOutside();
  return comments;
}

function scanKind(kind, source, firstLine) {
  if (TS_EXTENSIONS.has(`.${kind}`)) return scanTypeScript(source, firstLine, kind);
  if (kind === 'py') return scanPython(source, firstLine);
  if (kind === 'sh') return scanShell(source, firstLine);
  if (kind === 'hcl') return scanHcl(source, firstLine);
  if (kind === 'yaml') return scanYaml(source, firstLine);
  if (kind === 'css') return scanCss(source, firstLine);
  if (kind === 'html') return scanHtml(source, firstLine);
  return scanConfig(source, firstLine, kind);
}

function scannerFor(file, source) {
  const extension = extname(file).toLowerCase();
  const name = basename(file).toLowerCase();
  if (TS_EXTENSIONS.has(extension)) return (text) => scanTypeScript(text, 1, extension.slice(1));
  if (extension === '.py' || extension === '.pyw') return (text) => scanPython(text, 1);
  if (['.sh', '.bash', '.zsh', '.ksh'].includes(extension)) return (text) => scanShell(text, 1);
  if (extension === '.tf' || extension === '.hcl') return (text) => scanHcl(text, 1);
  if (extension === '.yml' || extension === '.yaml') return (text) => scanYaml(text, 1);
  if (extension === '.css') return (text) => scanCss(text, 1);
  if (extension === '.html' || extension === '.htm') return (text) => scanHtml(text, 1);
  if (extension === '.md' || extension === '.markdown') return (text) => scanMarkdown(text, 1);
  if (name === 'dockerfile' || name === 'containerfile' || extension === '.dockerfile') {
    return (text) => scanConfig(text, 1, 'dockerfile');
  }
  if (CONFIG_EXTENSIONS.has(extension)) return (text) => scanConfig(text, 1, extension.slice(1));
  if (/^#!.*\b(?:ba|z|k)?sh\b/.test(source)) return (text) => scanShell(text, 1);
  if (/^#!.*\bpython(?:3(?:\.\d+)?)?\b/.test(source)) return (text) => scanPython(text, 1);
  if (/^#!.*\bnode\b/.test(source)) return (text) => scanTypeScript(text, 1, 'js');
  return null;
}

function excluded(file) {
  const name = basename(file);
  return EXCLUDED_FILES.has(name) || VCS_FILES.has(name) || name === '.dockerignore'
    || /\.min\.(?:js|css)$/.test(name) || /(?:^|\.)lock$/.test(name);
}

export function commentInventory(root) {
  const inventory = Object.create(null);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('inventory root must be a real directory');
  const walk = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join('/');
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        if (excluded(path) || EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        throw new Error(`${name}: symbolic link encountered during inventory`);
      }
      if (stat.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) walk(path);
        continue;
      }
      if (!stat.isFile() || excluded(path)) continue;
      const source = readFileSync(path, 'utf8');
      const scan = scannerFor(path, source);
      if (!scan) continue;
      try {
        const lines = [...scan(source)].sort((a, b) => a - b);
        if (lines.length) inventory[name] = lines;
      } catch (error) {
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  walk(root);
  const sorted = Object.create(null);
  for (const [file, lines] of Object.entries(inventory).sort(([a], [b]) => a.localeCompare(b))) sorted[file] = lines;
  return sorted;
}
