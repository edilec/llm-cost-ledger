#!/usr/bin/env node
import { auditCosts, ConfigError, exitCodeFor } from '../src/index.mjs'

const HELP = `llm-cost-ledger — inspect exported model usage and a user-supplied dated price table.

Usage: llm-cost-ledger --root DIR --usage FILE --prices FILE [--json] [limits]

Options:
  --root DIR                 Root containing both exports (required)
  --usage FILE               Relative usage JSON file (required)
  --prices FILE              Relative dated prices JSON file (required)
  --max-document-bytes N     Bytes in each export (default 1048576)
  --max-usages N             Usage records (default 10000)
  --max-workflows N          Workflows (default 2000)
  --max-prices N             Dated price rows (default 5000)
  --max-findings N           Findings in a report (default 2000)
  --timeout-ms N             Cooperative deadline (default 30000; max 3600000)
  --json                     Omit human summary on stderr
  --help                     Print help

No network, provider account or bill is consulted. Exit 0: complete and within
budget; 1: complete and over budget; 2: invalid usage (empty stdout) or
incomplete evidence (JSON report on stdout).
`

const LIMIT_FLAGS = new Map([
  ['--max-document-bytes', 'maxDocumentBytes'], ['--max-usages', 'maxUsages'],
  ['--max-workflows', 'maxWorkflows'], ['--max-prices', 'maxPrices'],
  ['--max-findings', 'maxFindings'], ['--timeout-ms', 'timeoutMs'],
])

function parse(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const options = { limits: {} }
  const seen = new Set()
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at]
    if (seen.has(flag)) throw new ConfigError('Repeated option')
    seen.add(flag)
    if (flag === '--json') { options.json = true; continue }
    if (!['--root', '--usage', '--prices'].includes(flag) && !LIMIT_FLAGS.has(flag)) {
      throw new ConfigError('Unknown option')
    }
    const value = argv[++at]
    if (value === undefined || value.startsWith('--')) throw new ConfigError(`${flag} needs a value`)
    if (LIMIT_FLAGS.has(flag)) {
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))
        || (flag === '--timeout-ms' && Number(value) > 3600000)) {
        throw new ConfigError(`${flag} requires a positive bounded integer`)
      }
      options.limits[LIMIT_FLAGS.get(flag)] = Number(value)
    } else options[flag.slice(2)] = value
  }
  for (const required of ['root', 'usage', 'prices']) {
    if (!options[required]) throw new ConfigError(`--${required} is required`)
  }
  return options
}

try {
  const { json, help, ...options } = parse(process.argv.slice(2))
  if (help) {
    process.stdout.write(HELP)
  } else {
    const report = await auditCosts(options)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!json) process.stderr.write(`${report.status}: ${report.summary.checked} usage(s), ${report.summary.unresolved} unpriced.\n`)
    process.exitCode = exitCodeFor(report)
  }
} catch (error) {
  process.stderr.write(`${error instanceof ConfigError ? error.message : 'The review could not complete.'}\n`)
  process.exitCode = 2
}
