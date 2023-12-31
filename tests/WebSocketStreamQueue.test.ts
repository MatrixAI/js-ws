import { fc, testProp } from '@fast-check/jest';
import WebSocketStreamQueue from '@/WebSocketStreamQueue';

describe(WebSocketStreamQueue.name, () => {
  testProp('should queue items', [fc.array(fc.uint8Array())], (array) => {
    const queue = new WebSocketStreamQueue();
    let totalLength = 0;
    let totalByteLength = 0;
    for (const buffer of array) {
      queue.queue(buffer);
      totalByteLength += buffer.byteLength;
      totalLength += buffer.length;
    }
    expect(queue.count).toBe(array.length);
    expect(queue.byteLength).toBe(totalByteLength);
    expect(queue.length).toBe(totalLength);
  });
  testProp('should dequeue items', [fc.array(fc.uint8Array())], (array) => {
    const queue = new WebSocketStreamQueue();
    for (const buffer of array) {
      queue.queue(buffer);
    }
    const result: Array<Uint8Array> = [];
    for (let i = 0; i < array.length; i++) {
      result.push(queue.dequeue()!);
    }
    expect(result).toEqual(array);
    expect(queue.count).toBe(0);
    expect(queue.byteLength).toBe(0);
    expect(queue.length).toBe(0);
  });
  testProp('should iterate', [fc.array(fc.uint8Array())], (array) => {
    const queue = new WebSocketStreamQueue();
    for (const buffer of array) {
      queue.queue(buffer);
    }
    const outputArray: Array<Uint8Array> = [];
    for (const item of queue) {
      outputArray.push(item);
    }
    expect(outputArray).toEqual(array);
  });
});
