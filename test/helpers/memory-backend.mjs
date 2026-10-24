import { StorageError } from '@deepseek-ai/dsh-storage'

function validateDescriptor(descriptor) {
  if (!/^[a-z][a-z0-9_]*$/.test(descriptor.name)) {
    throw new StorageError('malformed-medium', `invalid unit name '${descriptor.name}'`)
  }
  for (const table of descriptor.tables) {
    if (!/^[a-z][a-z0-9_]*$/.test(table)) {
      throw new StorageError('malformed-medium', `invalid table name '${table}' in unit '${descriptor.name}'`)
    }
  }
}

/**
 * In-memory backend for DSH storage contract tests.
 */
export class MemoryBackend {
  units = new Map()

  kv = {
    open: async descriptor => {
      validateDescriptor(descriptor)
      if (this.units.has(descriptor.name)) throw new Error(`unit '${descriptor.name}' is already open`)
      const unit = new MemoryUnit(descriptor, () => this.units.delete(descriptor.name))
      this.units.set(descriptor.name, unit)
      return unit
    },
  }

  async close() {
    for (const unit of [...this.units.values()]) await unit.close()
  }
}

class MemoryUnit {
  constructor(descriptor, onClose) {
    this.descriptor = descriptor
    this.onClose = onClose
    this.closed = false
    this.state = {
      global: null,
      tables: new Map(descriptor.tables.map(table => [table, new Map()])),
    }
  }

  assertOpen() {
    if (this.closed) throw new StorageError('closed', 'unit is closed')
  }

  async loadAll() {
    this.assertOpen()
    const tables = {}
    for (const [table, records] of this.state.tables) tables[table] = Object.fromEntries(records)
    return { tables, global: this.state.global }
  }

  async putRecord(table, key, value) {
    this.assertOpen()
    const records = this.state.tables.get(table)
    if (!records) throw new Error(`unit does not declare table '${table}'`)
    records.set(key, value)
  }

  async deleteRecord(table, key) {
    this.assertOpen()
    this.state.tables.get(table)?.delete(key)
  }

  async setGlobal(value) {
    this.assertOpen()
    this.state.global = value
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.onClose()
  }
}
