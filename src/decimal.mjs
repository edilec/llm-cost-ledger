/** Integer pico-dollars: a six-decimal dollar rate per million tokens. */
export function decimalMicros(value, maximum) {
  if (typeof value !== 'string' || value.length > 20 || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const scaled = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0') || '0')
  return scaled <= BigInt(maximum) * 1000000n ? scaled : null
}

export function dollars(picos) {
  const whole = picos / 1000000000000n
  const fraction = String(picos % 1000000000000n).padStart(12, '0')
  return `${whole}.${fraction}`
}

export function budgetPicos(value) {
  const micros = decimalMicros(value, 1000000000)
  return micros === null ? null : micros * 1000000n
}
