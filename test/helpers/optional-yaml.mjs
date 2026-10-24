/**
 * Optional YAML parser for the patch tests.
 *
 * `yaml` is a **devDependency only**: it exists so tests can prove the
 * hand-written YAML emitter in `src/patch.mjs` produces something a real parser
 * accepts. Production code imports nothing outside Node's standard library.
 *
 * A bare checkout without `npm install` has no `yaml`. Rather than fail the
 * whole suite, the patch tests skip when it is missing — the emitter still runs,
 * just without independent verification.
 */
let parse

try {
  ;({ parse } = await import('yaml'))
} catch {
  parse = undefined
}

export const yamlParse = parse
export const hasYaml = typeof parse === 'function'

/** Skip reason shared by every test that needs a real parser. */
export const YAML_SKIP = 'devDependency "yaml" is not installed (run: npm install)'
