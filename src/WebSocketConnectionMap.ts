import type WebSocketConnection from './WebSocketConnection.js';
import { default as resourceCounter } from 'resource-counter';

// This is a workaround for when Vite will recognise `resourceCounter` as the module itself.
const Counter =
  typeof resourceCounter === 'function'
    ? resourceCounter
    : resourceCounter.default;

class WebSocketConnectionMap extends Map<number, WebSocketConnection> {
  protected counter: typeof Counter;
  public constructor() {
    super();
    this.counter = new Counter(0);
  }
  public allocateId(): number {
    return this.counter.allocate();
  }
  public add(conn: WebSocketConnection): this {
    const key = conn.connectionId;
    return this.set(key, conn);
  }
  public delete(key: number): boolean {
    this.counter.deallocate(key);
    return super.delete(key);
  }
  public clear(): void {
    this.counter = new Counter(0);
    return super.clear();
  }
}

export default WebSocketConnectionMap;
