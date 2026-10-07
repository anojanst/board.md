// Reads YAML frontmatter, and rewrites one top-level scalar line in place so that every other
// byte of the file stays the same.
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';

export interface Frontmatter {
  /** The YAML between the fences, including its last line ending. */
  yaml: string;
  /** Offset of the YAML's first character. */
  start: number;
  /** Offset just past the closing fence's line. */
  end: number;
  body: string;
}

export function splitFrontmatter(text: string): Frontmatter | null {
  const open = /^﻿?---[ \t]*\r?\n/.exec(text);
  if (!open) return null;
  const start = open[0].length;
  let pos = start;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const next = nl === -1 ? text.length : nl + 1;
    if (/^(?:---|\.\.\.)[ \t]*\r?$/.test(text.slice(pos, nl === -1 ? text.length : nl)))
      return { yaml: text.slice(start, pos), start, end: next, body: text.slice(next) };
    if (nl === -1) break;
    pos = next;
  }
  return null;
}

/** Parses a task file's frontmatter. Throws an Error that says what's wrong. */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const fm = splitFrontmatter(text);
  if (!fm) throw new Error('no frontmatter (the file must start with a --- line)');
  return { data: parseYaml(fm.yaml), body: fm.body };
}

function parseYaml(yaml: string): Record<string, unknown> {
  const doc = YAML.parseDocument(yaml, { uniqueKeys: true, prettyErrors: false });
  const [error] = doc.errors;
  if (error) throw new Error(`frontmatter is not valid YAML: ${error.message.split('\n')[0]}`);
  const data: unknown = doc.toJS({ maxAliasCount: 100 });
  if (data === null || data === undefined) return {};
  if (typeof data !== 'object' || Array.isArray(data))
    throw new Error('frontmatter must be a list of key: value pairs');
  return data as Record<string, unknown>;
}

export type ReplaceResult = { ok: true; text: string } | { ok: false; reason: string };

/** A value one frontmatter line can hold. null writes an empty value (`pr:`). */
export type Scalar = string | number | boolean | null;

/**
 * Replaces the value on a top-level `key: value` line in the frontmatter. The key, the spacing,
 * the quote style, any trailing comment and the line ending are kept, and the rest of the file is
 * untouched. Refuses (rather than guessing) when the line is missing or isn't a one-line scalar.
 */
export function replaceFrontmatterValue(text: string, key: string, value: Scalar): ReplaceResult {
  const fm = splitFrontmatter(text);
  if (!fm) return { ok: false, reason: 'the file has no frontmatter' };
  const line = findKeyLine(fm, text, key);
  if (!line) return { ok: false, reason: `the frontmatter has no "${key}:" line` };

  const { start, end, keyPart, prefix, raw } = line;
  const parsed = splitValue(raw);
  if (!parsed) return { ok: false, reason: `"${key}:" is not a one-line value` };
  const { quote, rest } = parsed;
  let replacement: string;
  if (value === null) {
    replacement = `${keyPart}${rest ? ` ${rest.trimStart()}` : ''}`;
  } else {
    const formatted =
      typeof value !== 'string'
        ? String(value)
        : quote === "'"
          ? `'${value.replaceAll("'", "''")}'`
          : quote === '"'
            ? JSON.stringify(value)
            : formatScalar(value);
    // `status:` with no value needs a space before the new one.
    const spaced = /[ \t]$/.test(prefix) ? prefix : `${prefix} `;
    replacement =
      parsed.value === ''
        ? `${spaced}${formatted}${rest ? ` ${rest.trimStart()}` : ''}`
        : `${prefix}${formatted}${rest}`;
  }
  return verified(fm, text.slice(0, start) + replacement + text.slice(end), key, value);
}

/**
 * Sets a top-level frontmatter value: rewrites its line, or adds `key: value` as the last line of
 * the frontmatter when there's no line for it yet.
 */
export function setFrontmatterValue(text: string, key: string, value: Scalar): ReplaceResult {
  const fm = splitFrontmatter(text);
  if (!fm) return { ok: false, reason: 'the file has no frontmatter' };
  if (findKeyLine(fm, text, key)) return replaceFrontmatterValue(text, key, value);
  if (!/^[A-Za-z_][\w-]*$/.test(key)) return { ok: false, reason: `"${key}" isn't a simple key` };
  const eol = /\r\n/.test(text.slice(0, fm.start)) ? '\r\n' : '\n';
  const line = value === null ? `${key}:` : `${key}: ${formatScalar(value)}`;
  const at = fm.start + fm.yaml.length;
  return verified(fm, text.slice(0, at) + line + eol + text.slice(at), key, value);
}

/** Belt and braces: the new frontmatter must parse, with only `key` changed. */
function verified(fm: Frontmatter, out: string, key: string, value: Scalar): ReplaceResult {
  try {
    const before = parseYaml(fm.yaml);
    const after = parseYaml(splitFrontmatter(out)!.yaml);
    if (after[key] !== value || !isDeepStrictEqual({ ...after, [key]: null }, { ...before, [key]: null }))
      return { ok: false, reason: `couldn't change "${key}:" without touching other values` };
  } catch {
    return { ok: false, reason: `couldn't change "${key}:" safely` };
  }
  return { ok: true, text: out };
}

/** A scalar as YAML: plain when that reads back the same, single-quoted otherwise. */
export function formatScalar(value: Scalar): string {
  if (value === null) return '';
  if (typeof value !== 'string') return String(value);
  return plainSafe(value) ? value : `'${value.replaceAll("'", "''")}'`;
}

/** True when the frontmatter has a `key:` line that `replaceFrontmatterValue` can rewrite. */
export function hasEditableLine(text: string, key: string): boolean {
  const fm = splitFrontmatter(text);
  const line = fm && findKeyLine(fm, text, key);
  return !!line && splitValue(line.raw) !== null;
}

interface KeyLine {
  /** Offset of the line's first character. */
  start: number;
  /** Offset of the line ending (or the end of the text). */
  end: number;
  /** `key:`, as written. */
  keyPart: string;
  /** `key:` plus the spaces after it. */
  prefix: string;
  /** Everything after the prefix, up to the line ending. */
  raw: string;
}

function findKeyLine(fm: Frontmatter, text: string, key: string): KeyLine | null {
  const re = new RegExp(`^(${escapeRegExp(key)}[ \\t]*:)([ \\t]*)(.*?)\\r?$`);
  let pos = fm.start;
  const end = fm.start + fm.yaml.length;
  while (pos < end) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 || nl > end ? end : nl;
    const content = text.slice(pos, lineEnd);
    const m = re.exec(content);
    // `status:todo` is a plain string in YAML, not a key, so a value needs a space before it.
    if (m && !(m[2] === '' && m[3] !== '')) {
      const [, keyPart, spaces, raw] = m as unknown as [string, string, string, string];
      const prefix = keyPart + spaces;
      return { start: pos, end: pos + prefix.length + raw.length, keyPart, prefix, raw };
    }
    pos = lineEnd + 1;
  }
  return null;
}

/** Splits a one-line YAML scalar into its value and what follows it (spaces and a comment). */
function splitValue(raw: string): { value: string; quote: '' | "'" | '"'; rest: string } | null {
  if (raw === '') return { value: '', quote: '', rest: '' };
  if (raw.startsWith('#')) return { value: '', quote: '', rest: raw };
  let end: number;
  let quote: '' | "'" | '"' = '';
  if (raw.startsWith("'")) {
    quote = "'";
    end = 1;
    for (;;) {
      const i = raw.indexOf("'", end);
      if (i === -1) return null;
      if (raw[i + 1] === "'") end = i + 2;
      else {
        end = i + 1;
        break;
      }
    }
  } else if (raw.startsWith('"')) {
    quote = '"';
    let i = 1;
    while (i < raw.length && raw[i] !== '"') i += raw[i] === '\\' ? 2 : 1;
    if (i >= raw.length) return null;
    end = i + 1;
  } else {
    // Block scalars, flow collections, anchors, aliases and tags aren't simple values.
    if (/^[|>[{&*!%@`]/.test(raw)) return null;
    const comment = /[ \t]+#/.exec(raw);
    end = (comment ? raw.slice(0, comment.index) : raw).trimEnd().length;
  }
  const rest = raw.slice(end);
  if (!/^(?:[ \t]*|[ \t]+#.*)$/.test(rest)) return null;
  return { value: raw.slice(0, end), quote, rest };
}

function plainSafe(value: string): boolean {
  if (value === '' || value !== value.trim() || /[\r\n]/.test(value)) return false;
  try {
    return YAML.parse(value) === value;
  } catch {
    return false;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
