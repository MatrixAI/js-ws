import type WebSocketConnection from './WebSocketConnection';
import Counter from 'resource-counter';

class WebSocketConnectionMap extends Map<number, WebSocketConnection> {
  protected counter: Counter<number>;
  public constructor() {
    super();
    this.counter = new Counter(0);
  }
  public allocateId(): number {
    return this.counter.allocate();
  }
  public add(conn: WebSocketConnection): this {
    const key = this.allocateId();
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
