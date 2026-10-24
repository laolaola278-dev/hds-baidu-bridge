/**
 * Convert a glob to a path-aware regular expression.
 * Supports `**`, `*`, `?` and literal characters only.
 * @param {string} pattern POSIX-style glob.
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        const followedBySlash = pattern[index + 2] === '/'
        source += followedBySlash ? '(?:.*/)?' : '.*'
        index += followedBySlash ? 2 : 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if ('\\^$+?.()|{}[]'.includes(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }
  return new RegExp(`^${source}$`)
}

/**
 * Build a reusable matcher for ordered exclude patterns.
 * @param {readonly string[]} patterns
 * @returns {(relative: string, isDirectory?: boolean) => boolean}
 */
export function createExcludeMatcher(patterns = []) {
  const compiled = []
  for (const raw of patterns) {
    let pattern = String(raw).replaceAll('\\', '/').replace(/^\.\//, '')
    if (!pattern) continue
    if (pattern.endsWith('/')) pattern += '**'
    if (pattern.endsWith('/**')) {
      const base = pattern.slice(0, -3)
      compiled.push({ base, regex: globToRegExp(pattern), baseRegex: globToRegExp(base) })
    } else {
      compiled.push({ base: undefined, regex: globToRegExp(pattern), baseRegex: undefined })
    }
  }
  return (relative, isDirectory = false) => {
    const normalized = String(relative).replaceAll('\\', '/').replace(/^\.\//, '')
    for (const entry of compiled) {
      if (entry.regex.test(normalized)) return true
      if (isDirectory && entry.baseRegex?.test(normalized)) return true
    }
    return false
  }
}
