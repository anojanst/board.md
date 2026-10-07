import { describe, expect, it } from 'vitest';
import {
  hasEditableLine,
  parseFrontmatter,
  replaceFrontmatterValue,
  setFrontmatterValue,
  splitFrontmatter,
} from '../src/frontmatter.js';

/** Lines that differ between two texts, split the same way git does (on \n). */
function changedLines(before: string, after: string): Array<[string, string]> {
  const a = before.split('\n');
  const b = after.split('\n');
  expect(b).toHaveLength(a.length);
  return a.flatMap((line, i) => (line === b[i] ? [] : [[line, b[i]!] as [string, string]]));
}

function replace(text: string, value: string, key = 'status'): string {
  const result = replaceFrontmatterValue(text, key, value);
  if (!result.ok) throw new Error(result.reason);
  return result.text;
}

const TASK = `---
id: DEMO-4
title: 'Decide: hosting'
status: todo
endpoints:
  - GET|POST /projects
branch:
pr:
---

# DEMO-4

status: todo is mentioned in the body too.
`;

describe('replaceFrontmatterValue', () => {
  it('changes exactly one line and leaves every other byte alone', () => {
    const out = replace(TASK, 'blocked');
    expect(changedLines(TASK, out)).toEqual([['status: todo', 'status: blocked']]);
    expect(out.replace('status: blocked', 'status: todo')).toBe(TASK);
    expect(out).toContain('status: todo is mentioned in the body too.');
  });

  it('keeps CRLF line endings', () => {
    const crlf = TASK.replaceAll('\n', '\r\n');
    const out = replace(crlf, 'in-progress');
    expect(changedLines(crlf, out)).toEqual([['status: todo\r', 'status: in-progress\r']]);
    expect(Buffer.byteLength(out) - Buffer.byteLength(crlf)).toBe('in-progress'.length - 'todo'.length);
  });

  it('keeps single and double quotes', () => {
    const single = TASK.replace('status: todo', "status: 'todo'");
    expect(changedLines(single, replace(single, 'done'))).toEqual([["status: 'todo'", "status: 'done'"]]);
    const double = TASK.replace('status: todo', 'status: "todo"');
    expect(changedLines(double, replace(double, 'done'))).toEqual([['status: "todo"', 'status: "done"']]);
  });

  it('keeps the key spacing and a trailing comment', () => {
    const spaced = TASK.replace('status: todo', 'status :   todo   # set by hand');
    expect(changedLines(spaced, replace(spaced, 'done'))).toEqual([
      ['status :   todo   # set by hand', 'status :   done   # set by hand'],
    ]);
  });

  it('fills in an empty value', () => {
    const empty = TASK.replace('status: todo', 'status:');
    expect(changedLines(empty, replace(empty, 'todo'))).toEqual([['status:', 'status: todo']]);
  });

  it('quotes a value that YAML would read as something else', () => {
    expect(replace(TASK, 'null')).toContain("status: 'null'");
    expect(replace(TASK, 'a: b')).toContain("status: 'a: b'");
    expect(parseFrontmatter(replace(TASK, '42')).data.status).toBe('42');
  });

  it('keeps a byte order mark and a file without a trailing newline', () => {
    const text = `﻿---\nid: X-1\nstatus: todo\n---`;
    expect(replace(text, 'done')).toBe(`﻿---\nid: X-1\nstatus: done\n---`);
  });

  it('refuses when there is no status line', () => {
    const none = TASK.replace('status: todo\n', '');
    expect(replaceFrontmatterValue(none, 'status', 'done')).toEqual({
      ok: false,
      reason: 'the frontmatter has no "status:" line',
    });
    expect(hasEditableLine(none, 'status')).toBe(false);
    expect(hasEditableLine(TASK, 'status')).toBe(true);
  });

  it('ignores indented and look-alike keys', () => {
    const nested = TASK.replace('status: todo\n', 'meta:\n  status: todo\nstatusx: todo\n');
    expect(replaceFrontmatterValue(nested, 'status', 'done').ok).toBe(false);
  });

  it('refuses multi-line and flow values rather than guessing', () => {
    for (const value of ['|\n  todo', '>-\n  todo', '[todo]', '&a todo', "'to\n  do'"]) {
      const text = TASK.replace('status: todo', `status: ${value}`);
      expect(replaceFrontmatterValue(text, 'status', 'done').ok, value).toBe(false);
    }
  });

  it('refuses a file without frontmatter', () => {
    expect(replaceFrontmatterValue('# Just a note\n', 'status', 'done').ok).toBe(false);
  });
});

describe('setFrontmatterValue', () => {
  const set = (text: string, key: string, value: string | number | null) => {
    const result = setFrontmatterValue(text, key, value);
    if (!result.ok) throw new Error(result.reason);
    return result.text;
  };

  it('writes numbers and empty values on their one line', () => {
    expect(changedLines(TASK, set(TASK, 'pr', 41))).toEqual([['pr:', 'pr: 41']]);
    const withBranch = set(TASK, 'branch', 'task/demo-4-x');
    expect(changedLines(withBranch, set(withBranch, 'branch', null))).toEqual([['branch: task/demo-4-x', 'branch:']]);
    expect(parseFrontmatter(set(TASK, 'pr', 41)).data.pr).toBe(41);
  });

  it('adds a missing key as the last frontmatter line, with the file\'s line endings', () => {
    expect(set(TASK, 'reviewer', 'sam')).toBe(TASK.replace('pr:\n---', 'pr:\nreviewer: sam\n---'));
    const crlf = TASK.replaceAll('\n', '\r\n');
    expect(set(crlf, 'reviewer', 'sam')).toBe(crlf.replace('pr:\r\n---', 'pr:\r\nreviewer: sam\r\n---'));
    expect(setFrontmatterValue(TASK, 'bad key', 'x').ok).toBe(false);
  });
});

describe('parseFrontmatter', () => {
  it('reads values, lists and quoted titles', () => {
    const { data, body } = parseFrontmatter(TASK);
    expect(data).toMatchObject({
      id: 'DEMO-4',
      title: 'Decide: hosting',
      status: 'todo',
      endpoints: ['GET|POST /projects'],
      branch: null,
      pr: null,
    });
    expect(body).toMatch(/^\n# DEMO-4/);
  });

  it('explains what is wrong', () => {
    expect(() => parseFrontmatter('# no frontmatter')).toThrow(/no frontmatter/);
    expect(() => parseFrontmatter('---\nid: [unclosed\n---\n')).toThrow(/not valid YAML/);
    expect(() => parseFrontmatter('---\nid: 1\nid: 2\n---\n')).toThrow(/not valid YAML/);
    expect(() => parseFrontmatter('---\n- a\n- b\n---\n')).toThrow(/key: value/);
  });

  it('finds the closing fence', () => {
    expect(splitFrontmatter('---\n---\nbody')).toMatchObject({ yaml: '', body: 'body' });
    expect(splitFrontmatter('---\na: 1\n...\nbody')?.yaml).toBe('a: 1\n');
    expect(splitFrontmatter('---\na: 1\n')).toBeNull();
  });
});
