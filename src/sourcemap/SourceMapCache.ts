import { SourceMapConsumer } from 'source-map';

/**
 * Intrusive doubly-linked list node. `head` is the MRU end, `tail` is LRU.
 * On `get` and `set`, the touched node moves to the head in O(1).
 */
interface Node {
  key: string;
  consumer: SourceMapConsumer;
  prev: Node | null;
  next: Node | null;
}

/**
 * LRU cache for parsed SourceMapConsumers. Evictions MUST call
 * `consumer.destroy()` — the `source-map` library backs each consumer with
 * WASM memory that leaks if not freed.
 *
 * Previously a linear-scan LRU which became the HMR thrashing bottleneck:
 * every `set()` past capacity cost O(n) across every cached consumer. Now
 * O(1) via an intrusive doubly-linked list.
 */
export class SourceMapCache {
  private map = new Map<string, Node>();
  private head: Node | null = null;  // MRU
  private tail: Node | null = null;  // LRU
  private maxSize: number;

  constructor(maxSize: number = 500) {
    this.maxSize = maxSize;
  }

  get(key: string): SourceMapConsumer | undefined {
    const node = this.map.get(key);
    if (!node) return undefined;
    this.moveToHead(node);
    return node.consumer;
  }

  set(key: string, consumer: SourceMapConsumer): void {
    const existing = this.map.get(key);
    if (existing) {
      // Replacing — destroy the old consumer first to free WASM memory.
      if (existing.consumer !== consumer) {
        try { existing.consumer.destroy(); } catch { /* best-effort */ }
      }
      existing.consumer = consumer;
      this.moveToHead(existing);
      return;
    }

    const node: Node = { key, consumer, prev: null, next: null };
    this.map.set(key, node);
    this.addToHead(node);

    if (this.map.size > this.maxSize && this.tail) {
      const evicted = this.tail;
      this.removeNode(evicted);
      this.map.delete(evicted.key);
      try { evicted.consumer.destroy(); } catch { /* best-effort */ }
    }
  }

  delete(key: string): void {
    const node = this.map.get(key);
    if (!node) return;
    this.removeNode(node);
    this.map.delete(key);
    try { node.consumer.destroy(); } catch { /* best-effort */ }
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  clear(): void {
    for (const node of this.map.values()) {
      try { node.consumer.destroy(); } catch { /* best-effort */ }
    }
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  get size(): number {
    return this.map.size;
  }

  private addToHead(node: Node): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private removeNode(node: Node): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  private moveToHead(node: Node): void {
    if (this.head === node) return;
    this.removeNode(node);
    this.addToHead(node);
  }
}
