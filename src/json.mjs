/** Inspect a syntactically valid JSON document before JSON.parse erases repeated keys. */
export function hasDuplicateKeys(text) {
  const stack = []
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at]
    if (character === '{') stack.push({ type: 'object', keys: new Set(), expectingKey: true })
    else if (character === '[') stack.push({ type: 'array' })
    else if (character === '}' || character === ']') stack.pop()
    else if (character === ',' && stack.at(-1)?.type === 'object') stack.at(-1).expectingKey = true
    else if (character === ':' && stack.at(-1)?.type === 'object') stack.at(-1).expectingKey = false
    else if (character === '"') {
      const start = at
      for (at += 1; at < text.length; at += 1) {
        if (text[at] === '\\') { at += 1; continue }
        if (text[at] === '"') break
      }
      const frame = stack.at(-1)
      if (frame?.type === 'object' && frame.expectingKey) {
        const key = JSON.parse(text.slice(start, at + 1))
        if (frame.keys.has(key)) return true
        frame.keys.add(key)
      }
    }
  }
  return false
}
