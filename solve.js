// A fast drop-in replacement for makefun-site 1.0.0.
//
// run(input) builds one site exactly as the reference does — same front
// matter refusals, same slugs, same Markdown dialect, same template
// dialect, same report — while spending far less CPU:
//   * slugs and long dates are memoised (titles, tags and headings repeat
//     heavily across a site), and pure-ASCII slugs skip NFKD entirely;
//   * Markdown is rendered in a single pass over the lines, and inline
//     text is escaped in whole runs instead of character by character;
//   * templates are compiled once into plain JavaScript functions, so
//     rendering hundreds of pages is ordinary function calls, not a
//     tree walk with a scope-chain search per node.

// ---------------------------------------------------------------- text

const ESCAPED = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with the five HTML-significant characters replaced. */
function escapeText(text) {
  // One scan: replace returns the string itself when nothing matches.
  return text.replace(/[&<>"']/g, (c) => ESCAPED[c]);
}

const slugCache = new Map();

/** The reference slug rule, memoised; ASCII input never pays for NFKD. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  let out = '';
  let gap = false;
  const eat = (plain) => {
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  };
  if (ascii) eat(text);
  else eat(text.normalize('NFKD').replace(/\p{M}/gu, ''));
  out = out.slice(0, 64).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  if (slugCache.size > 30000) slugCache.clear();
  slugCache.set(text, slug);
  return slug;
}

/** The first of slug, slug-2, slug-3, ... not in `taken`; records it. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

/** "2026-11-09" in words, memoised. */
function longDate(date) {
  const hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const parts = date.split('-');
  const out = `${Number(parts[2])} ${MONTH_NAMES[Number(parts[1]) - 1]} ${parts[0]}`;
  dateCache.set(date, out);
  return out;
}

/** Whitespace in the `\s` sense, by char code. */
function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 ||
    c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** How many runs of non-whitespace `text` holds. */
function countWords(text) {
  // A hand loop over char codes: the regex form would allocate an array
  // holding every word of every body, which costs more than it saves.
  let n = 0;
  let inside = false;
  for (let i = 0; i < text.length; i++) {
    if (isSpaceCode(text.charCodeAt(i))) inside = false;
    else if (!inside) { inside = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------- front matter

const KNOWN_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const KEY_LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LAYOUT_SHAPE = /^[a-z0-9-]+$/;
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_SHAPE = /^[^"[\]]+$/;

function monthDays(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A title/summary value: quoted with only \" and \\ escapes, or bare. */
function readString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One front-matter value by its key, or the refusal reason. */
function readValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = readString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_SHAPE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > monthDays(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_SHAPE.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return LAYOUT_SHAPE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_SHAPE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * Split a source into { data, body } or { error }. The closing fence is
 * located before any line is judged, matching the reference's order of
 * refusals.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  const fmLines = [];
  let pos = firstNl + 1;
  let bodyStart = -1;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    if (line === '---') {
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    fmLines.push(line);
    if (nl === -1) break;
    pos = nl + 1;
    if (pos > text.length) break;
    if (pos === text.length) { fmLines.push(''); break; }
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c !== ' ' && c !== '\t') { blank = false; break; }
    }
    if (blank || line.startsWith('#')) continue;
    const m = KEY_LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KNOWN_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = readValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The fence language when `line` opens a fence, else null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line[i];
    const ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
      c === '_' || c === '+' || c === '-';
    if (!ok) break;
    i++;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    if (line[i] !== ' ' && line[i] !== '\t') return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** A heading's { depth, text }, or null. */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line[d] === '#') d++;
  if (d === 0 || d > 6) return null;
  if (d === line.length) return null;
  const c = line[d];
  if (c !== ' ' && c !== '\t') return null;
  let i = d;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  let b = line.length;
  while (b > i && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  const text = line.slice(i, b);
  return text === '' ? null : { depth: d, text };
}

function isBreak(line) {
  let head = null;
  if (line.startsWith('---')) head = 3;
  else if (line.startsWith('***')) head = 3;
  else return false;
  for (let i = head; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** A bullet item's text when `line` opens one, else null. */
function bulletText(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered item { start, text } opener match, or null. */
function orderedMatch(line) {
  let d = 0;
  while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
  if (d === 0 || d > 9) return null;
  if (line[d] !== '.' || line[d + 1] !== ' ') return null;
  return { start: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

function isContinuation(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i < 2 || i === line.length) return false;
  // The reference asks for a non-whitespace character here, in the full
  // Unicode sense of `\S`, not merely "not a space or tab".
  return !isSpaceCode(line.charCodeAt(i));
}

function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isBreak(line);
}

/** First index at or after `from` holding `what` outside an escape. */
function findUnescaped(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First lone `*` at or after `from` (not part of a pair), outside escapes. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/**
 * Inline rendering. Plain runs between the four active characters
 * (backslash, backtick, star, bracket) are escaped in one slice each.
 */
function renderInline(s, link) {
  let out = '';
  let i = 0;
  let plain = 0;
  const flush = (upto) => {
    if (upto > plain) out += escapeText(s.slice(plain, upto));
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
        flush(i);
        const n = s[i + 1];
        out += n === '>' ? '&gt;' : n;
        i += 2;
        plain = i;
      } else i++;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        out += '<code>' + escapeText(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          out += '<strong>' + renderInline(s.slice(i + 2, j), link) + '</strong>';
          i = j + 2;
          plain = i;
        } else {
          flush(i);
          out += '**';
          i += 2;
          plain = i;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          flush(i);
          out += '<em>' + renderInline(s.slice(i + 1, j), link) + '</em>';
          i = j + 1;
          plain = i;
        } else i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        out += '<a href="' + escapeText(link(target)) + '">' + renderInline(s.slice(i + 1, k), link) + '</a>';
        i = m + 1;
        plain = i;
      } else i++;
      continue;
    }
    i++;
  }
  flush(s.length);
  return out;
}

/** One body rendered: its HTML, its level 2/3 toc and its excerpt. */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let inner = '';
      for (const l of body) inner += escapeText(l) + '\n';
      const cls = lang === '' ? '' : ` class="language-${escapeText(lang)}"`;
      blocks.push(`<pre><code${cls}>${inner}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = renderInline(heading.text, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isBreak(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        // The reference drops the ">" and at most one following space.
        const raw = lines[i];
        const stripped = raw[1] === ' ' ? raw.slice(2) : raw.slice(1);
        i++;
        const t = trimLine(stripped);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0
        ? '<blockquote>\n</blockquote>'
        : `<blockquote>\n<p>${renderInline(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = bulletText(line);
    const ordered = bullet === null ? orderedMatch(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        const text = isOrdered ? orderedMatch(cur)?.text : bulletText(cur);
        if (text !== undefined && text !== null) {
          items.push([trimLine(text)]);
          i++;
        } else if (items.length > 0 && isContinuation(cur)) {
          items[items.length - 1].push(trimLine(cur));
          i++;
        } else break;
      }
      let inner = '';
      for (const parts of items) inner += `<li>${renderInline(parts.join('\n'), link)}</li>\n`;
      if (isOrdered) {
        const open = ordered.start !== 1 ? `<ol start="${ordered.start}">` : '<ol>';
        blocks.push(`${open}\n${inner}</ol>`);
      } else {
        blocks.push(`<ul>\n${inner}</ul>`);
      }
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = renderInline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += b + '\n';
  return { html, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------- templates

const PATH_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_SHAPE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_SHAPE = /^if (not )?(\S+)$/;
const INCLUDE_SHAPE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

class TemplateProblem extends Error {}

function pathOf(name, text) {
  if (!PATH_SHAPE.test(text)) {
    throw new TemplateProblem(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateProblem(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      }
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateProblem(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** Parse a template source into a node tree, or throw TemplateProblem. */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_SHAPE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_SHAPE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) {
          throw new TemplateProblem(`template "${name}": an else outside an if`);
        }
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateProblem(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_SHAPE.exec(tag)) !== null) {
        body.push({ kind: 'include', name: m[1] });
      } else {
        throw new TemplateProblem(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) {
    throw new TemplateProblem(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  }
  return root.body;
}

/** Resolve `path` against the scope chain: first name by scope, rest by own property of objects only. */
function lookupPath(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A template value as text. */
function valueText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(valueText).join(', ');
  return '';
}

function valueTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Tree-walking renderer, kept as the fallback if code generation ever refuses a template. */
function renderNodes(nodes, scope, templates, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += escapeText(valueText(lookupPath(scope, n.path)));
        break;
      case 'raw':
        out += valueText(lookupPath(scope, n.path));
        break;
      case 'if': {
        const v = valueTruthy(lookupPath(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, templates, depth);
        break;
      }
      case 'for': {
        const xs = lookupPath(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, templates, depth);
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t.nodes, scope, templates, depth + 1);
        break;
      }
    }
  }
  return out;
}

/** Scope-chain head lookup: the nearest scope holding `key`, else undefined. */
function lookupHead(scope, key) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, key)) s = s.parent;
  return s === null ? undefined : s.vars[key];
}

function lookupStep(v, key) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, key) ? v[key] : undefined;
}

const HELP = {
  get: lookupPath,
  g1: (scope, a) => lookupHead(scope, a),
  g2: (scope, a, b) => lookupStep(lookupHead(scope, a), b),
  g3: (scope, a, b, c) => lookupStep(lookupStep(lookupHead(scope, a), b), c),
  str: valueText,
  esc: escapeText,
  tru: valueTruthy,
  inc(name, scope, depth, templates) {
    if (depth >= INCLUDE_DEPTH) return '';
    const t = templates.get(name);
    return t === undefined ? '' : t.render(scope, depth + 1, templates);
  },
};

let tempCounter = 0;

/** The generated expression reading `path` in `scopeVar`, without allocating a path array. */
function getExpr(scopeVar, path) {
  const args = path.map((p) => JSON.stringify(p)).join(', ');
  if (path.length <= 3) return `H.g${path.length}(${scopeVar}, ${args})`;
  return `H.get(${scopeVar}, ${JSON.stringify(path)})`;
}

/** Emit JavaScript statements rendering `nodes` into `__o`, with `scopeVar` naming the current scope. */
function emitNodes(nodes, scopeVar, lines) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        lines.push(`__o += ${JSON.stringify(n.text)};`);
        break;
      case 'var':
        lines.push(`__o += H.esc(H.str(${getExpr(scopeVar, n.path)}));`);
        break;
      case 'raw':
        lines.push(`__o += H.str(${getExpr(scopeVar, n.path)});`);
        break;
      case 'if': {
        const id = tempCounter++;
        lines.push(`{ const __v${id} = H.tru(${getExpr(scopeVar, n.path)});`);
        lines.push(`if (__v${id} !== ${n.not}) {`);
        emitNodes(n.then, scopeVar, lines);
        if (n.else !== null) {
          lines.push('} else {');
          emitNodes(n.else, scopeVar, lines);
        }
        lines.push('} }');
        break;
      }
      case 'for': {
        const id = tempCounter++;
        lines.push(`{ const __xs${id} = ${getExpr(scopeVar, n.path)};`);
        lines.push(`if (Array.isArray(__xs${id})) {`);
        lines.push(`const __n${id} = __xs${id}.length;`);
        lines.push(`for (let __k${id} = 0; __k${id} < __n${id}; __k${id}++) {`);
        lines.push(`const __sc${id} = { vars: { ${JSON.stringify(n.name)}: __xs${id}[__k${id}], loop: { index: __k${id} + 1, first: __k${id} === 0, last: __k${id} === __n${id} - 1, length: __n${id} } }, parent: ${scopeVar} };`);
        emitNodes(n.body, `__sc${id}`, lines);
        lines.push('} } }');
        break;
      }
      case 'include':
        lines.push(`__o += H.inc(${JSON.stringify(n.name)}, ${scopeVar}, __depth, __templates);`);
        break;
    }
  }
}

/** Compile a parsed template into a render function; falls back to the tree walker on any refusal. */
function compileTemplate(nodes) {
  try {
    tempCounter = 0;
    const lines = ["let __o = '';"];
    emitNodes(nodes, '__scope', lines);
    lines.push('return __o;');
    const fn = new Function('__scope', '__depth', '__templates', 'H', lines.join('\n'));
    return (scope, depth, templates) => fn(scope, depth, templates, HELP);
  } catch {
    return (scope, depth, templates) => renderNodes(nodes, scope, { get: (nm) => templates.get(nm) }, depth);
  }
}

// ----------------------------------------------------------------- build

const RESERVED_DIRS = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function dirOf(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/** `rel` resolved against source directory `dir`, or null when it climbs above the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens with a URI scheme, as the reference's pattern decides. */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
      c === 43 || c === 45 || c === 46;
    if (!ok) return false;
  }
  return false;
}

/** One case's whole output tree: every written path mapped to its text. */
export function run(input) {
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      templates.set(name, { nodes, render: compileTemplate(nodes) });
    } catch (err) {
      if (!(err instanceof TemplateProblem)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // Front matter and the refusal ladder, in the reference's order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED_DIRS) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: slugs unique per directory, assigned in source order.
  const takenByDir = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED_DIRS : []);
      takenByDir.set(dir, taken);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, with links resolved against pages and static files.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, ties by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags, grouped by slug in collection order.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const tagBySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = tagBySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        tagBySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return tagBySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tagList = [...tagBySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );

  // Cards and pages as templates read them; each card is built once.
  const cardOf = (s) => {
    if (s.card !== undefined) return s.card;
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = card;
    return card;
  };
  const linkOf = (s) => (s === null || s === undefined ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.post ? s.newer : null),
    older: linkOf(s.post ? s.older : null),
    is_post: s.post,
  });

  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map(cardOf);
  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    return t.render({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0, templates);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map(cardOf),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map(cardOf) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageTotal = kept.reduce((n, s) => n + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
