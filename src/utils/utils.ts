import type { PromiseDeconstructed } from './types';
import type { Parsed, StreamId } from '@/types';
import * as errors from '../errors';

function never(): never {
  throw new errors.ErrorWebSocketUndefinedBehaviour();
}

/**
 * Deconstructed promise
 */
function promise<T = void>(): PromiseDeconstructed<T> {
  let resolveP, rejectP;
  const p = new Promise<T>((resolve, reject) => {
    resolveP = resolve;
    rejectP = reject;
  });
  return {
    p,
    resolveP,
    rejectP,
  };
}

function toStreamId(array: Uint8Array): Parsed<StreamId> {
  let streamId: bigint;

  // Get header and prefix
  const header = array[0];
  const prefix = header >> 6;

  // Copy bytearray and remove prefix
  const arrayCopy = new Uint8Array(array.length);
  arrayCopy.set(array);
  arrayCopy[0] &= 0b00111111;

  const dv = new DataView(arrayCopy.buffer, arrayCopy.byteOffset);

  let readBytes = 0;

  switch (prefix) {
    case 0b00:
      readBytes = 1;
      streamId = BigInt(dv.getUint8(0));
      break;
    case 0b01:
      readBytes = 2;
      streamId = BigInt(dv.getUint16(0, false));
      break;
    case 0b10:
      readBytes = 4;
      streamId = BigInt(dv.getUint32(0, false));
      break;
    case 0b11:
      readBytes = 8;
      streamId = dv.getBigUint64(0, false);
      break;
  }
  return {
    data: streamId! as StreamId,
    remainder: array.subarray(readBytes),
  };
}

function fromStreamId(streamId: StreamId): Uint8Array {
  const id = streamId as bigint;

  let array: Uint8Array;
  let dv: DataView;
  let prefixMask = 0;

  if (id < 0x40) {
    array = new Uint8Array(1);
    dv = new DataView(array.buffer);
    dv.setUint8(0, Number(id));
  } else if (id < 0x4000) {
    array = new Uint8Array(2);
    dv = new DataView(array.buffer);
    dv.setUint16(0, Number(id));
    prefixMask = 0b01_000000;
  } else if (id < 0x40000000) {
    array = new Uint8Array(4);
    dv = new DataView(array.buffer);
    dv.setUint32(0, Number(id));
    prefixMask = 0b10_000000;
  } else {
    array = new Uint8Array(8);
    dv = new DataView(array.buffer);
    dv.setBigUint64(0, id);
    prefixMask = 0b11_000000;
  }

  let header = dv.getUint8(0);
  header |= prefixMask;
  dv.setUint8(0, header);

  return array;
}

enum StreamCode {
  DATA = 0,
  ACK = 1,
  ERROR = 2,
  CLOSE = 3,
}

export { never, promise, toStreamId, fromStreamId, StreamCode };
