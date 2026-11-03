/**
 * Python string semantics the CarryOn runtime depends on, so the TS port gives the same results as carrycode on
 * the parity fixtures: `str.strip()` / `str.split()` whitespace, `len()` in code points and
 * `posixpath.normpath`.
 *
 * @module dsh-carryon/pystr
 */

/** Characters for which Python's `str.isspace()` is true (differs from JS `\s`: adds \x1c-\x1f and \x85, no ﻿). */
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g')
const PY_RUN = new RegExp(`[${PY_WS}]+`)

/**
 * Python `s.strip()`.
 * @returns `s` without leading and trailing whitespace.
 */
export function pyStrip(s: string): string {
  return s.replace(PY_STRIP, '')
}

/**
 * Python `s.split()` with no separator: split on runs of whitespace, no empty strings.
 * @returns the words of `s`.
 */
export function pySplit(s: string): string[] {
  const stripped = pyStrip(s)
  return stripped === '' ? [] : stripped.split(PY_RUN)
}

/**
 * Code points of `s`; Python indexes and measures strings in code points, JS in UTF-16 units.
 * @returns one string per code point.
 */
export function codePoints(s: string): string[] {
  return Array.from(s)
}

/**
 * Python `len(s)`.
 * @returns the number of code points in `s`.
 */
export function pyLen(s: string): number {
  let n = 0
  for (const _ of s) n += 1
  return n
}

/**
 * Python `posixpath.normpath(path)`: collapse `//`, `.` and `a/..` without touching the file system. A leading
 * `//` (exactly two slashes) is kept, as POSIX allows it to mean something else.
 * @returns the normalized path, `.` for an empty result.
 */
export function posixNormpath(path: string): string {
  if (path === '') return '.'
  let initialSlashes = path.startsWith('/') ? 1 : 0
  if (initialSlashes && path.startsWith('//') && !path.startsWith('///')) initialSlashes = 2
  const out: string[] = []
  for (const comp of path.split('/')) {
    if (comp === '' || comp === '.') continue
    if (comp !== '..' || (!initialSlashes && out.length === 0) || out.at(-1) === '..') out.push(comp)
    else if (out.length > 0) out.pop()
  }
  const joined = '/'.repeat(initialSlashes) + out.join('/')
  return joined === '' ? '.' : joined
}
