/**
 * What the mod keeps in memory, by key, within a budget of bytes: past it, the least recently used
 * entries go first, those `isPinned` says are in use (a GIF playing) after every other.
 *
 * Reading an entry with `get` makes it the most recently used; `has` and `peek` leave the order.
 */
export class Budget<T> {
  private readonly entries = new Map<string, { value: T; weight: number }>()
  private total = 0

  constructor (
    private readonly limit: number,
    private readonly onEvict: (key: string) => void = () => {},
    private readonly isPinned: (key: string) => boolean = () => false
  ) {}

  /** The bytes held. */
  get bytes () {
    return this.total
  }

  has (key: string) {
    return this.entries.has(key)
  }

  peek (key: string) {
    return this.entries.get(key)?.value
  }

  get (key: string) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  /** Keeps `value` as the most recently used, `weight` bytes of it; past the budget, others go. */
  set (key: string, value: T, weight: number) {
    this.delete(key)
    this.entries.set(key, { value, weight })
    this.total += weight
    this.trim(key)
  }

  delete (key: string) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.total -= entry.weight
    this.entries.delete(key)
  }

  clear () {
    this.entries.clear()
    this.total = 0
  }

  keys () {
    return [...this.entries.keys()]
  }

  /** Drops the least recently used until within the budget: the unpinned first; never `keep`. */
  private trim (keep: string) {
    for (const pass of [false, true]) {
      for (const key of this.keys()) {
        if (this.total <= this.limit) return
        if (key === keep || (!pass && this.isPinned(key))) continue
        this.delete(key)
        this.onEvict(key)
      }
    }
  }
}
