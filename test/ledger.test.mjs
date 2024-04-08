import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { auditCosts } from '../src/index.mjs'

const CLEAN_PRICES = {
  schemaVersion: '1',
  prices: [
    { model: 'local-small', effectiveDate: '2026-01-01', inputPerMillion: '1.000000', outputPerMillion: '2.000000', cacheReadPerMillion: '0.500000' },
    { model: 'local-small', effectiveDate: '2026-07-01', inputPerMillion: '2.000000', outputPerMillion: '3.000000', cacheReadPerMillion: '0.250000' },
  ],
}

const CLEAN_USAGE = {
  schemaVersion: '1',
  workflows: [{ id: 'alpha', outcome: 'success', budget: '10.000000' }],
  usages: [
    { id: 'first', workflowId: 'alpha', model: 'local-small', date: '2026-06-30', inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000 },
    { id: 'second', workflowId: 'alpha', model: 'local-small', date: '2026-07-01', inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000 },
  ],
}

async function fixture(t, usage = CLEAN_USAGE, prices = CLEAN_PRICES) {
  const root = await mkdtemp(join(tmpdir(), 'llm-cost-ledger-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'usage.json'), `${JSON.stringify(usage)}\n`)
  await writeFile(join(root, 'prices.json'), `${JSON.stringify(prices)}\n`)
  return { root, usage: 'usage.json', prices: 'prices.json' }
}

function cli(args) {
  return spawnSync(process.execPath, ['bin/llm-cost-ledger.mjs', ...args], { cwd: new URL('..', import.meta.url), encoding: 'utf8' })
}

test('good case: effective dates and cache pricing give exact decimal costs', async (t) => {
  const options = await fixture(t)
  const report = await auditCosts(options)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.usages.map((row) => [row.id, row.priceEffectiveDate, row.cost]), [
    ['first', '2026-01-01', '3.500000000000'],
    ['second', '2026-07-01', '5.250000000000'],
  ])
  assert.equal(report.workflows[0].cost, '8.750000000000')
  assert.equal(report.workflows[0].costPerOutcome, '8.750000000000')
  assert.equal(report.summary.checked, 2)
  const run = cli(['--root', options.root, '--usage', options.usage, '--prices', options.prices, '--json'])
  assert.equal(run.status, 0)
  assert.equal(JSON.parse(run.stdout).status, 'pass')
})

test('unknown model price is unresolved on either dated side, not a zero or a live bill', async (t) => {
  const usage = structuredClone(CLEAN_USAGE)
  usage.usages[0].model = 'unknown-model'
  const options = await fixture(t, usage)
  const report = await auditCosts(options)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['price-unresolved'])
  assert.equal(report.usages[0].cost, null)
  assert.equal(report.workflows[0].cost, null)
  assert.equal(report.summary.unresolved, 1)
  const run = cli(['--root', options.root, '--usage', options.usage, '--prices', options.prices, '--json'])
  assert.equal(run.status, 2)
  assert.equal(JSON.parse(run.stdout).status, 'incomplete')
})

test('a price that takes effect tomorrow cannot price yesterday', async (t) => {
  const prices = structuredClone(CLEAN_PRICES)
  prices.prices = prices.prices.slice(1)
  const options = await fixture(t, CLEAN_USAGE, prices)
  const report = await auditCosts(options)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.usages[0].cost, null)
  assert.equal(report.usages[1].cost, '5.250000000000')
  assert.equal(report.workflows[0].cost, null)
})

test('a measured budget overrun fails, while equality is allowed', async (t) => {
  const over = structuredClone(CLEAN_USAGE)
  over.workflows[0].budget = '8.749999'
  const overReport = await auditCosts(await fixture(t, over))
  assert.equal(overReport.status, 'fail')
  assert.deepEqual(overReport.findings.map((item) => item.ruleId), ['budget-exceeded'])
  const equal = structuredClone(CLEAN_USAGE)
  equal.workflows[0].budget = '8.750000'
  const equalReport = await auditCosts(await fixture(t, equal))
  assert.equal(equalReport.status, 'pass')
})

test('unreadable evidence exits 2 with a report; invalid usage exits 2 with empty stdout', async (t) => {
  const options = await fixture(t)
  const missing = cli(['--root', options.root, '--usage', 'missing.json', '--prices', options.prices, '--json'])
  assert.equal(missing.status, 2)
  assert.equal(JSON.parse(missing.stdout).status, 'incomplete')
  const unknown = cli(['--root', options.root, '--usage', options.usage, '--prices', options.prices, '--prcies', 'bad'])
  assert.equal(unknown.status, 2)
  assert.equal(unknown.stdout, '')
  assert.match(unknown.stderr, /Unknown option/)
})

test('a duplicate dated price refuses the index rather than choosing a winner', async (t) => {
  const prices = structuredClone(CLEAN_PRICES)
  prices.prices.push({ ...prices.prices[0], inputPerMillion: '99.000000' })
  const report = await auditCosts(await fixture(t, CLEAN_USAGE, prices))
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['input-invalid'])
  assert.deepEqual(report.usages, [])
})

test('each document and record bound accepts N and refuses N+1', async (t) => {
  const options = await fixture(t)
  const usageBytes = Buffer.byteLength(`${JSON.stringify(CLEAN_USAGE)}\n`)
  const pricesBytes = Buffer.byteLength(`${JSON.stringify(CLEAN_PRICES)}\n`)
  const bytes = Math.max(usageBytes, pricesBytes)
  assert.equal((await auditCosts({ ...options, limits: { maxDocumentBytes: bytes } })).status, 'pass')
  const tooSmall = await auditCosts({ ...options, limits: { maxDocumentBytes: bytes - 1 } })
  assert.equal(tooSmall.status, 'incomplete')
  assert.ok(tooSmall.findings.some((item) => item.ruleId === 'input-too-large'))
  assert.equal((await auditCosts({ ...options, limits: { maxUsages: 2, maxPrices: 2, maxWorkflows: 1 } })).status, 'pass')
  for (const limits of [{ maxUsages: 1 }, { maxPrices: 1 }]) {
    const report = await auditCosts({ ...options, limits })
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.findings.map((item) => item.ruleId), ['too-many-records'])
  }
  const twoWorkflows = structuredClone(CLEAN_USAGE)
  twoWorkflows.workflows.push({ id: 'beta', outcome: 'failure', budget: '1.000000' })
  twoWorkflows.usages.push({ ...twoWorkflows.usages[0], id: 'third', workflowId: 'beta' })
  const two = await fixture(t, twoWorkflows)
  const atWorkflows = await auditCosts({ ...two, limits: { maxWorkflows: 2 } })
  assert.equal(atWorkflows.status, 'fail')
  assert.deepEqual(atWorkflows.findings.map((item) => item.ruleId), ['budget-exceeded'])
  const limited = await auditCosts({ ...two, limits: { maxWorkflows: 1 } })
  assert.equal(limited.status, 'incomplete')
  assert.deepEqual(limited.findings.map((item) => item.ruleId), ['too-many-records'])
})

test('finding limit is silent at N and explicitly incomplete at N+1', async (t) => {
  const usage = structuredClone(CLEAN_USAGE)
  usage.usages[0].model = 'unpriced-a'
  usage.usages[1].model = 'unpriced-b'
  const options = await fixture(t, usage)
  const at = await auditCosts({ ...options, limits: { maxFindings: 2 } })
  assert.deepEqual(at.findings.map((item) => item.ruleId), ['price-unresolved', 'price-unresolved'])
  const over = await auditCosts({ ...options, limits: { maxFindings: 1 } })
  assert.deepEqual(over.findings.map((item) => item.ruleId), ['findings-truncated'])
  assert.equal(over.status, 'incomplete')
})

test('timeout is silent at N and publishes no partial ledger at N+1', async (t) => {
  const options = await fixture(t)
  const at = await auditCosts({ ...options, limits: { timeoutMs: 5 }, now: (() => { let n = 0; return () => n++ === 0 ? 0 : 5 })() })
  assert.equal(at.status, 'pass')
  const over = await auditCosts({ ...options, limits: { timeoutMs: 5 }, now: (() => { let n = 0; return () => n++ === 0 ? 0 : 6 })() })
  assert.equal(over.status, 'incomplete')
  assert.deepEqual(over.findings.map((item) => item.ruleId), ['analysis-timeout'])
  assert.deepEqual(over.usages, [])
  assert.deepEqual(over.workflows, [])
})

test('a symlinked input outside root is not read or priced', async (t) => {
  const options = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), 'llm-cost-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'secret.json'), 'synthetic-secret-value')
  await symlink(join(outside, 'secret.json'), join(options.root, 'linked.json'))
  const report = await auditCosts({ ...options, prices: 'linked.json' })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['input-outside-root'])
  assert.ok(!JSON.stringify(report).includes('synthetic-secret-value'))
})

test('wrong-shaped and unparseable inputs never leak a synthetic canary', async (t) => {
  const options = await fixture(t)
  await writeFile(join(options.root, options.prices), '{"password":"synthetic-secret-value",')
  const report = await auditCosts(options)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['input-unreadable'])
  assert.ok(!JSON.stringify(report).includes('synthetic-secret-value'))
})

test('an empty workflow or an empty export is incomplete, never a vacuous pass', async (t) => {
  const usage = structuredClone(CLEAN_USAGE)
  usage.workflows.push({ id: 'unused', outcome: 'failure' })
  const options = await fixture(t, usage)
  const report = await auditCosts(options)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['no-usage'])
  assert.equal(report.workflows.find((item) => item.id === 'unused').cost, null)

  const empty = { schemaVersion: '1', workflows: [], usages: [] }
  const emptyReport = await auditCosts(await fixture(t, empty))
  assert.equal(emptyReport.status, 'incomplete')
  assert.deepEqual(emptyReport.findings.map((item) => item.ruleId), ['no-usage'])
  assert.equal(emptyReport.summary.checked, 0)
})

test('missing cache count and duplicate usage ids invalidate evidence rather than becoming zero or overwritten', async (t) => {
  const withoutCache = structuredClone(CLEAN_USAGE)
  delete withoutCache.usages[0].cacheReadTokens
  const absent = await auditCosts(await fixture(t, withoutCache))
  assert.equal(absent.status, 'incomplete')
  assert.deepEqual(absent.findings.map((item) => item.ruleId), ['input-invalid'])
  const duplicate = structuredClone(CLEAN_USAGE)
  duplicate.usages[1].id = duplicate.usages[0].id
  const repeated = await auditCosts(await fixture(t, duplicate))
  assert.equal(repeated.status, 'incomplete')
  assert.deepEqual(repeated.findings.map((item) => item.ruleId), ['input-invalid'])
  assert.deepEqual(repeated.usages, [])
})

test('report order is code-unit stable and completed output has no clock', async (t) => {
  const usage = structuredClone(CLEAN_USAGE)
  usage.usages[0].id = 'a'
  usage.usages[1].id = 'Z'
  const options = await fixture(t, usage)
  const first = await auditCosts({ ...options, now: () => 1 })
  const second = await auditCosts({ ...options, now: () => 999 })
  assert.deepEqual(first.usages.map((item) => item.id), ['Z', 'a'])
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})

test('a path containing a bidi control is invalid configuration, never an output location', async (t) => {
  const options = await fixture(t)
  const run = cli(['--root', options.root, '--usage', `u${String.fromCharCode(0x202e)}sage.json`, '--prices', options.prices])
  assert.equal(run.status, 2)
  assert.equal(run.stdout, '')
  assert.ok(!run.stderr.includes(String.fromCharCode(0x202e)))
})

test('timeout configuration accepts its maximum and refuses one past it', async (t) => {
  const options = await fixture(t)
  const allowed = cli(['--root', options.root, '--usage', options.usage, '--prices', options.prices, '--timeout-ms', '3600000', '--json'])
  assert.equal(allowed.status, 0)
  const refused = cli(['--root', options.root, '--usage', options.usage, '--prices', options.prices, '--timeout-ms', '3600001'])
  assert.equal(refused.status, 2)
  assert.equal(refused.stdout, '')
  assert.match(refused.stderr, /--timeout-ms/)
})

test('findings sort by their actual pointer in UTF-16 code-unit order', async (t) => {
  const usage = structuredClone(CLEAN_USAGE)
  usage.usages = Array.from({ length: 12 }, (_, at) => ({ ...usage.usages[0], id: `item-${at}`, model: 'unpriced-fixture' }))
  const report = await auditCosts(await fixture(t, usage))
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((item) => item.location.pointer), [0, 1, 10, 11, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `/usages/${n}/model`))
})

test('a recorded zero-token use is a priced zero, not mistaken for absent evidence', async (t) => {
  const usage = structuredClone(CLEAN_USAGE)
  usage.usages = [{ ...usage.usages[0], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }]
  usage.workflows[0].budget = '0'
  const report = await auditCosts(await fixture(t, usage))
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.workflows[0].cost, '0.000000000000')
  assert.equal(report.summary.checked, 1)
})
