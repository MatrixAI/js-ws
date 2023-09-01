import type { PromiseDeconstructed } from './types';
import type { Parsed, StreamId } from '@/types';
import * as errors from '../errors';

function never(message?: string): never {
  throw new errors.ErrorWebSocketUndefinedBehaviour(message);
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

function toVarInt(array: Uint8Array): Parsed<bigint> {
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
    data: streamId!,
    remainder: array.subarray(readBytes),
  };
}

function fromVarInt(varInt: bigint): Uint8Array {
  let array: Uint8Array;
  let dv: DataView;
  let prefixMask = 0;

  if (varInt < 0x40) {
    array = new Uint8Array(1);
    dv = new DataView(array.buffer);
    dv.setUint8(0, Number(varInt));
  } else if (varInt < 0x4000) {
    array = new Uint8Array(2);
    dv = new DataView(array.buffer);
    dv.setUint16(0, Number(varInt));
    prefixMask = 0b01_000000;
  } else if (varInt < 0x40000000) {
    array = new Uint8Array(4);
    dv = new DataView(array.buffer);
    dv.setUint32(0, Number(varInt));
    prefixMask = 0b10_000000;
  } else {
    array = new Uint8Array(8);
    dv = new DataView(array.buffer);
    dv.setBigUint64(0, varInt);
    prefixMask = 0b11_000000;
  }

  let header = dv.getUint8(0);
  header |= prefixMask;
  dv.setUint8(0, header);

  return array;
}

const fromStreamId = fromVarInt as (streamId: StreamId) => Uint8Array;
const toStreamId = toVarInt as (array: Uint8Array) => Parsed<StreamId>;

enum StreamMessageType {
  DATA = 0,
  ACK = 1,
  ERROR = 2,
  CLOSE = 3,
}

enum StreamShutdown {
  Read = 0,
  Write = 1,
}

export {
  never,
  promise,
  toVarInt,
  fromVarInt,
  toStreamId,
  fromStreamId,
  StreamMessageType,
  StreamShutdown,
};
