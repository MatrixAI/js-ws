/**
 * WebSocketStreamQueue can have 3 states regarding the head and the tail:
 * - if (head == null && head === tail) then the queue is empty
 * - if (head != null && head === tail) then the queue has 1 item
 * - if (head != null && head !== tail) then the queue has 2 or more items
 */
class WebSocketStreamQueue {
  protected head?: WebSocketStreamQueueItem;
  protected tail?: WebSocketStreamQueueItem;
  protected _byteLength: number;
  protected _length: number;
  protected _count: number;

  /**
   * The combined byteLength of all queued `Uint8Array`.
   */
  public get byteLength(): Readonly<number> {
    return this._byteLength;
  }
  /**
   * The combined length of the queued `Uint8Array`s.
   */
  public get length(): Readonly<number> {
    return this._length;
  }
  /**
   * The number of queued `Uint8Array`.
   */
  public get count(): Readonly<number> {
    return this._count;
  }

  public [Symbol.iterator](): IterableIterator<Uint8Array> {
    let current = this.head;
    return {
      [Symbol.iterator]() {
        return this;
      },
      next() {
        const current_ = current;
        if (current_ == null) {
          return {
            value: undefined,
            done: true,
          };
        }
        current = current_.next;
        return {
          value: current_.data,
          done: false,
        };
      },
    };
  }

  constructor() {
    this._byteLength = 0;
    this._length = 0;
    this._count = 0;
  }
  public queue(data: Uint8Array): void {
    const item = {
      data,
    };
    // If there is no head, then this is the first item in the queue
    if (this.head == null) {
      this.head = item;
    }
    // If the tail exists, then set the next item on the tail to the new item
    if (this.tail != null) {
      this.tail.next = item;
    }
    // Set the tail to the new item
    this.tail = item;
    // Update the byteLength, length, and count
    this._byteLength += data.byteLength;
    this._length += data.length;
    this._count++;
  }
  /**
   * Returns the data of the head and removes the head from the queue.
   * If the queue is empty, then undefined is returned.
   */
  public dequeue(): Uint8Array | undefined {
    // Get the data of the head
    const oldData = this.head?.data;
    const newHead = this.head?.next;
    // If the head and the tail are the same, then the queue is either empty or only have one item
    if (this.head === this.tail) {
      this.tail = undefined;
    }
    this.head = newHead;
    // Decrement the count, but don't let it go below 0 in case the queue is empty
    this._count = this._count === 0 ? 0 : this._count - 1;
    this._byteLength -= oldData?.byteLength ?? 0;
    this._length -= oldData?.length ?? 0;
    return oldData;
  }
  public clear(): void {
    this._byteLength = 0;
    this._length = 0;
    this._count = 0;
    // Clearing head and tail should cause the garbage collector to clean up all the items in the queue
    this.head = undefined;
    this.tail = undefined;
  }
}

type WebSocketStreamQueueItem = {
  data: Uint8Array;
  next?: WebSocketStreamQueueItem;
};

export default WebSocketStreamQueue;
