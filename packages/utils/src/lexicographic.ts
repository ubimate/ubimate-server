/**
 * Lexicographic ordering utilities for stable, distributed-friendly ordering
 * 
 * This implementation uses base-62 encoding (0-9, A-Z, a-z) to create
 * lexicographically sortable strings that can be inserted between any
 * two existing strings, similar to fractional indexing.
 */

const BASE = 62
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const MIDPOINT = 'n' // Character at position 31 (roughly middle of our 62-char set)

/**
 * Generate a lexicographic string between two strings
 * @param before The string before the desired position (or null for beginning)
 * @param after The string after the desired position (or null for end)
 * @returns A new lexicographic string that sorts between before and after
 */
export function generateKeyBetween(before: string | null, after: string | null): string {
  // If both null, return midpoint
  if (!before && !after) {
    return MIDPOINT
  }

  // If only before exists, append to it
  if (before && !after) {
    // Just increment or append
    return before + MIDPOINT
  }

  // If only after exists, prepend to it
  if (!before && after) {
    // Find a character less than the first char of after
    const firstIndex = CHARS.indexOf(after[0])
    if (firstIndex > 0) {
      return CHARS[Math.floor(firstIndex / 2)]
    }
    // First char is '0', prepend '0' and use after's structure
    return '0' + after.slice(0, -1)
  }

  // Both exist - generate midpoint between them
  if (before && after) {
    // Validate order
    if (before >= after) {
      throw new Error('Invalid ordering: before must be less than after')
    }

    // Find the common prefix
    let i = 0
    while (i < before.length && i < after.length && before[i] === after[i]) {
      i++
    }

    // Common prefix
    const prefix = before.slice(0, i)

    // Get the differing parts
    const beforeRest = i < before.length ? before.slice(i) : ''
    const afterRest = i < after.length ? after.slice(i) : ''

    if (!afterRest) {
      // after is a prefix of before (shouldn't happen due to validation)
      // but if it does, append to before
      return before + MIDPOINT
    }

    if (!beforeRest) {
      // before is a prefix of after
      // Insert between before (empty) and after[i]
      const afterFirstChar = after[i]
      const afterIndex = CHARS.indexOf(afterFirstChar)
      
      if (afterIndex > 0) {
        // Can insert a character between '0' (implicit) and afterFirstChar
        return prefix + CHARS[Math.floor(afterIndex / 2)]
      }
      
      // afterFirstChar is '0', need to go deeper by appending
      return prefix + '0' + generateKeyBetween('', after.slice(i + 1))
    }

    // Both have remaining parts
    const beforeIndex = CHARS.indexOf(beforeRest[0])
    const afterIndex = CHARS.indexOf(afterRest[0])

    if (afterIndex - beforeIndex > 1) {
      // There's space between the characters
      const midIndex = beforeIndex + Math.floor((afterIndex - beforeIndex) / 2)
      return prefix + CHARS[midIndex]
    }

    // Characters are consecutive (diff === 1), need to go deeper
    if (afterIndex - beforeIndex === 1) {
      // We need to look at what comes after beforeRest[0]
      if (beforeRest.length > 1) {
        // before has more characters, try to increment
        const nextIndex = CHARS.indexOf(beforeRest[1])
        if (nextIndex < BASE - 1) {
          // Can increment the next character
          return prefix + beforeRest[0] + CHARS[nextIndex + 1]
        }
        // Next char is at max ('z'), need to continue recursively
        return prefix + beforeRest[0] + generateKeyBetween(beforeRest.slice(1), '')
      }
      
      // beforeRest is just one character
      // Since beforeRest[0] and afterRest[0] are consecutive, we can't insert between them
      // Strategy: look at what comes after to find insertion point
      if (afterRest.length > 1) {
        // after has more characters, we can insert between empty and afterRest.slice(1)
        // This creates a key like prefix + beforeRest[0] + <something less than afterRest.slice(1)>
        return prefix + beforeRest[0] + generateKeyBetween('', afterRest.slice(1))
      }
      
      // Both are single characters and consecutive (e.g., 'a' and 'b')
      // Append MIDPOINT to create space: 'a' < 'an' < 'b'
      return prefix + beforeRest[0] + MIDPOINT
    }

    // beforeIndex === afterIndex (same character)
    // Continue recursively with the rest
    return prefix + beforeRest[0] + generateKeyBetween(beforeRest.slice(1), afterRest.slice(1))
  }

  return MIDPOINT
}

/**
 * Generate N evenly distributed keys
 * @param count Number of keys to generate
 * @returns Array of lexicographic keys
 */
export function generateNKeys(count: number): string[] {
  if (count === 0) return []
  if (count === 1) return [MIDPOINT]

  const keys: string[] = []
  let prev: string | null = null

  for (let i = 0; i < count; i++) {
    const next = i === count - 1 ? null : undefined
    const key = generateKeyBetween(prev, next as string | null)
    keys.push(key)
    prev = key
  }

  return keys
}

/**
 * Generate a key at the start of a sequence
 */
export function generateFirstKey(): string {
  return generateKeyBetween(null, MIDPOINT)
}

/**
 * Generate a key at the end of a sequence
 */
export function generateLastKey(after: string): string {
  return generateKeyBetween(after, null)
}

/**
 * Validate that keys are in correct lexicographic order
 */
export function validateKeyOrder(keys: string[]): boolean {
  for (let i = 1; i < keys.length; i++) {
    if (keys[i - 1] >= keys[i]) {
      return false
    }
  }
  return true
}

/**
 * Rebalance keys if they're getting too long or uneven
 * This is an optimization to prevent keys from growing unbounded
 */
export function rebalanceKeys(keys: string[]): string[] {
  if (keys.length === 0) return []
  
  const newKeys: string[] = []
  let prev: string | null = null

  for (let i = 0; i < keys.length; i++) {
    const next = i === keys.length - 1 ? null : undefined
    const key = generateKeyBetween(prev, next as string | null)
    newKeys.push(key)
    prev = key
  }

  return newKeys
}
