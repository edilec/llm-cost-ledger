import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { budgetPicos, decimalMicros, dollars } from './decimal.mjs'
import { hasDuplicateKeys } from './json.mjs'

export const TOOL_ID = 'llm-cost-ledger'
export class ConfigError extends Error {}

export const DEFAULT_LIMITS = Object.freeze({
  maxDocumentBytes: 1048576,
  maxUsages: 10000,
  maxWorkflows: 2000,
  maxPrices: 5000,
  maxFindings: 2000,
  timeoutMs: 30000,
})

export const RULES = Object.freeze({
  'input-unreadable': Object.freeze({ severity: 'error', incomplete: true }),
  'input-outside-root': Object.freeze({ severity: 'error', incomplete: true }),
  'input-too-large': Object.freeze({ severity: 'error', incomplete: true }),
  'input-invalid': Object.freeze({ severity: 'error', incomplete: true }),
  'too-many-records': Object.freeze({ severity: 'error', incomplete: true }),
  'analysis-timeout': Object.freeze({ severity: 'error', incomplete: true }),
  'no-usage': Object.freeze({ severity: 'warning', incomplete: true }),
  'price-unresolved': Object.freeze({ severity: 'warning', incomplete: true }),
  'budget-exceeded': Object.freeze({ severity: 'error', incomplete: false }),
  'findings-truncated': Object.freeze({ severity: 'error', incomplete: true }),
})

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/
const KEYS = Object.freeze({
  usage: ['schemaVersion', 'workflows', 'usages'],
  workflow: ['id', 'outcome', 'budget'],
  record: ['id', 'workflowId', 'model', 'date', 'inputTokens', 'outputTokens', 'cacheReadTokens'],
  prices: ['schemaVersion', 'prices'],
  price: ['model', 'effectiveDate', 'inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion'],
})

const byCodeUnit = (a, b) => a === b ? 0 : a < b ? -1 : 1
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const keysAre = (object, allowed) => Object.keys(object).every((key) => allowed.includes(key))
const identifier = (value) => typeof value === 'string' && ID.test(value)
const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1000000000

function date(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function limitsFrom(given = {}) {
  if (!plain(given)) throw new ConfigError('limits must be an object')
  const result = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(given)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new ConfigError(`Unknown limit "${key}"`)
    if (!Number.isSafeInteger(value) || value < 1 || (key === 'timeoutMs' && value > 3600000)) {
      throw new ConfigError(`Limit "${key}" must be a positive bounded integer`)
    }
    result[key] = value
  }
  return result
}

function finding(ruleId, file, pointer, message) {
  const rule = RULES[ruleId]
  if (!rule) throw new Error(`Unknown rule ${ruleId}`)
  return { ruleId, severity: rule.severity, message, location: { file, pointer } }
}

function reportOf(findings, limits, usages = [], workflows = [], checked = 0, unresolved = 0) {
  const ordered = findings.sort((a, b) =>
    byCodeUnit(a.location.file, b.location.file)
    || byCodeUnit(a.location.pointer, b.location.pointer)
    || byCodeUnit(a.ruleId, b.ruleId))
  if (ordered.length > limits.maxFindings) {
    ordered.length = limits.maxFindings
    ordered[ordered.length - 1] = finding('findings-truncated', '', '', 'The finding limit was reached; later observations are unknown.')
    ordered.sort((a, b) => byCodeUnit(a.location.file, b.location.file)
      || byCodeUnit(a.location.pointer, b.location.pointer) || byCodeUnit(a.ruleId, b.ruleId))
  }
  const incomplete = ordered.some((item) => RULES[item.ruleId].incomplete)
  const status = incomplete ? 'incomplete' : ordered.some((item) => item.severity === 'error') ? 'fail' : 'pass'
  return {
    schemaVersion: '1', tool: TOOL_ID, status,
    summary: {
      checked, unresolved,
      errors: ordered.filter((item) => item.severity === 'error').length,
      warnings: ordered.filter((item) => item.severity === 'warning').length,
    },
    findings: ordered, usages, workflows,
  }
}

export const exitCodeFor = (report) => report.status === 'incomplete' ? 2 : report.status === 'fail' ? 1 : 0

/** The input name is a relative file beneath the declared root, not a host path. */
async function load(root, name, limits, label) {
  const target = resolve(root, name)
  let actual
  try {
    actual = await realpath(target)
  } catch {
    return { problem: finding('input-unreadable', name, '', `${label} could not be opened.`) }
  }
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) {
    return { problem: finding('input-outside-root', name, '', `${label} resolves outside the declared root and was not read.`) }
  }
  try {
    const info = await stat(actual)
    if (!info.isFile()) return { problem: finding('input-unreadable', name, '', `${label} is not a regular file.`) }
    if (info.size > limits.maxDocumentBytes) {
      return { problem: finding('input-too-large', name, '', `${label} exceeds maxDocumentBytes and was not read.`) }
    }
    const bytes = await readFile(actual)
    if (bytes.length > limits.maxDocumentBytes) {
      return { problem: finding('input-too-large', name, '', `${label} exceeds maxDocumentBytes and was not parsed.`) }
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value = JSON.parse(text)
    if (hasDuplicateKeys(text)) {
      return { problem: finding('input-invalid', name, '', `${label} has duplicate JSON keys; earlier values cannot be ignored.`) }
    }
    return { value }
  } catch {
    return { problem: finding('input-unreadable', name, '', `${label} could not be decoded or parsed as JSON.`) }
  }
}

function validateUsage(document, file, limits) {
  const invalid = (pointer, message) => finding('input-invalid', file, pointer, message)
  if (!plain(document) || !keysAre(document, KEYS.usage) || document.schemaVersion !== '1'
    || !Array.isArray(document.workflows) || !Array.isArray(document.usages)) {
    return invalid('', 'Usage must be a version 1 object with workflows and usages arrays and no unknown keys.')
  }
  if (document.workflows.length > limits.maxWorkflows || document.usages.length > limits.maxUsages) {
    return finding('too-many-records', file, '', 'Usage exceeds the declared workflow or usage record limit; no partial ledger was built.')
  }
  const workflowIds = new Set()
  for (const [at, item] of document.workflows.entries()) {
    if (!plain(item) || !keysAre(item, KEYS.workflow) || !identifier(item.id) || !identifier(item.outcome)
      || (item.budget !== undefined && budgetPicos(item.budget) === null) || workflowIds.has(item.id)) {
      return invalid(`/workflows/${at}`, 'A workflow needs a unique printable id, an outcome and an optional nonnegative six-decimal budget.')
    }
    workflowIds.add(item.id)
  }
  const usageIds = new Set()
  for (const [at, item] of document.usages.entries()) {
    if (!plain(item) || !keysAre(item, KEYS.record) || !identifier(item.id) || usageIds.has(item.id)
      || !workflowIds.has(item.workflowId) || !identifier(item.model) || !date(item.date)
      || !tokenCount(item.inputTokens) || !tokenCount(item.outputTokens) || !tokenCount(item.cacheReadTokens)) {
      return invalid(`/usages/${at}`, 'A usage needs a unique id, known workflow, model, valid date and bounded nonnegative token counts.')
    }
    usageIds.add(item.id)
  }
  return null
}

function validatePrices(document, file, limits) {
  const invalid = (pointer, message) => finding('input-invalid', file, pointer, message)
  if (!plain(document) || !keysAre(document, KEYS.prices) || document.schemaVersion !== '1' || !Array.isArray(document.prices)) {
    return invalid('', 'Prices must be a version 1 object with a prices array and no unknown keys.')
  }
  if (document.prices.length > limits.maxPrices) {
    return finding('too-many-records', file, '', 'The price table exceeds maxPrices; no partial pricing index was built.')
  }
  const seen = new Set()
  for (const [at, row] of document.prices.entries()) {
    if (!plain(row) || !keysAre(row, KEYS.price) || !identifier(row.model) || !date(row.effectiveDate)
      || decimalMicros(row.inputPerMillion, 1000000) === null
      || decimalMicros(row.outputPerMillion, 1000000) === null
      || decimalMicros(row.cacheReadPerMillion, 1000000) === null
      || seen.has(`${row.model}\u0000${row.effectiveDate}`)) {
      return invalid(`/prices/${at}`, 'A price needs a unique model/date, valid date and three bounded six-decimal rates.')
    }
    seen.add(`${row.model}\u0000${row.effectiveDate}`)
  }
  return null
}

/** Inspect only exported usage and supplied prices; no live provider or bill is consulted. */
export async function auditCosts(options = {}) {
  if (!plain(options)) throw new ConfigError('options must be an object')
  const { root, usage, prices, limits: givenLimits, now = Date.now, ...unknown } = options
  if (Object.keys(unknown).length) throw new ConfigError('Unknown option')
  const limits = limitsFrom(givenLimits)
  if (typeof root !== 'string' || !root || typeof usage !== 'string' || !usage
    || typeof prices !== 'string' || !prices) throw new ConfigError('root, usage and prices are required')
  if (isAbsolute(usage) || isAbsolute(prices) || [usage, prices].some((name) => name.split(/[\\/]/).includes('..') || /[\x00-\x1f\x7f-\x9f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(name))) {
    throw new ConfigError('usage and prices must be relative file names beneath root')
  }
  if (typeof now !== 'function') throw new ConfigError('now must be a clock function')
  const started = now()
  if (!Number.isFinite(started)) throw new ConfigError('now must return a finite number')
  const checkpoint = () => {
    const time = now()
    if (!Number.isFinite(time)) throw new ConfigError('now must return a finite number')
    if (time - started > limits.timeoutMs) throw new TimeoutError()
  }
  let realRoot
  try { realRoot = await realpath(root) } catch { throw new ConfigError('root could not be opened') }
  if (!(await stat(realRoot)).isDirectory()) throw new ConfigError('root must be a directory')
  try {
    checkpoint()
    const usageDoc = await load(realRoot, usage, limits, 'Usage export')
    checkpoint()
    const pricesDoc = await load(realRoot, prices, limits, 'Price table')
    checkpoint()
    const findings = [usageDoc.problem, pricesDoc.problem].filter(Boolean)
    if (findings.length) return reportOf(findings, limits)
    const usageProblem = validateUsage(usageDoc.value, usage, limits)
    const priceProblem = validatePrices(pricesDoc.value, prices, limits)
    if (usageProblem || priceProblem) return reportOf([usageProblem, priceProblem].filter(Boolean), limits)

    const table = new Map()
    for (const row of pricesDoc.value.prices) {
      checkpoint()
      if (!table.has(row.model)) table.set(row.model, [])
      table.get(row.model).push(row)
    }
    for (const rows of table.values()) rows.sort((a, b) => byCodeUnit(a.effectiveDate, b.effectiveDate))
    const totals = new Map(usageDoc.value.workflows.map((item) => [item.id, { cost: 0n, unresolved: false, count: 0 }]))
    const output = []
    for (const [at, record] of usageDoc.value.usages.entries()) {
      checkpoint()
      const available = table.get(record.model)?.filter((row) => row.effectiveDate <= record.date) ?? []
      const price = available.at(-1)
      const total = totals.get(record.workflowId)
      total.count += 1
      if (!price) {
        total.unresolved = true
        findings.push(finding('price-unresolved', usage, `/usages/${at}/model`, `No supplied price for model "${record.model}" took effect by ${record.date}; its cost is unknown.`))
        output.push({ id: record.id, workflowId: record.workflowId, model: record.model, date: record.date, priceEffectiveDate: null, cost: null })
        continue
      }
      const cost = BigInt(record.inputTokens) * decimalMicros(price.inputPerMillion, 1000000)
        + BigInt(record.outputTokens) * decimalMicros(price.outputPerMillion, 1000000)
        + BigInt(record.cacheReadTokens) * decimalMicros(price.cacheReadPerMillion, 1000000)
      total.cost += cost
      output.push({ id: record.id, workflowId: record.workflowId, model: record.model, date: record.date, priceEffectiveDate: price.effectiveDate, cost: dollars(cost) })
    }
    if (!output.length) findings.push(finding('no-usage', usage, '/usages', 'No usage was recorded; there is no cost evidence to verify.'))
    const workflows = []
    for (const [at, item] of usageDoc.value.workflows.entries()) {
      checkpoint()
      const total = totals.get(item.id)
      if (!total.count) {
        total.unresolved = true
        findings.push(finding('no-usage', usage, `/workflows/${at}`, `Workflow "${item.id}" has no usage evidence.`))
      }
      const budget = item.budget === undefined ? null : budgetPicos(item.budget)
      if (!total.unresolved && budget !== null && total.cost > budget) {
        findings.push(finding('budget-exceeded', usage, `/workflows/${at}/budget`, `Workflow "${item.id}" exceeds its supplied budget; no live bill was checked.`))
      }
      workflows.push({ id: item.id, outcome: item.outcome, budget: item.budget ?? null,
        cost: total.unresolved ? null : dollars(total.cost),
        costPerOutcome: total.unresolved ? null : dollars(total.cost),
        usages: total.count })
    }
    checkpoint()
    output.sort((a, b) => byCodeUnit(a.id, b.id))
    workflows.sort((a, b) => byCodeUnit(a.id, b.id))
    return reportOf(findings, limits, output, workflows, output.length, output.filter((item) => item.cost === null).length)
  } catch (error) {
    if (!(error instanceof TimeoutError)) throw error
    return reportOf([finding('analysis-timeout', usage, '', 'The time budget expired; no partial cost ledger was published.')], limits)
  }
}

class TimeoutError extends Error {}
