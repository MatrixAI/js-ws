class WebSocketStreamQueue {
  protected head?: WebSocketStreamQueueItem;
  protected tail?: WebSocketStreamQueueItem;
  protected _byteLength: number;
  protected _length: number;
  protected _count: number;

  public get byteLength(): Readonly<number> {
    return this._byteLength;
  }
  public get length(): Readonly<number> {
    return this._length
  }
  public get count(): Readonly<number> {
    return this._count;
  }
  constructor() {
    this._byteLength = 0;
    this._length = 0;
    this._count = 0;
  }
  public queue(data: Uint8Array) {
    const item = {
      data
    };
    if (this.head == null) {
      this.head = item;
    }
    if (this.tail != null) {
      this.tail.next = item;
    }
    this.tail = item;
    this._byteLength += data.byteLength;
    this._length += data.length;
    this._count++;
  }
  public dequeue() {
    const oldData = this.head?.data;
    const newHead = this.head?.next;
    if (this.head === this.tail) {
      delete this.tail;
    }
    delete this.head;
    this.head = newHead;
    this._count = this._count === 0 ? 0 : this._count - 1;
    this._byteLength -= oldData?.byteLength ?? 0;
    this._length -= oldData?.length ?? 0;
    return oldData;
  }
  public clear() {
    this._byteLength = 0;
    this._length = 0;
    this._count = 0;
    delete this.head;
    delete this.tail;
  }
}

type WebSocketStreamQueueItem = {
  data: Uint8Array;
  next?: WebSocketStreamQueueItem;
}

export default WebSocketStreamQueue;
