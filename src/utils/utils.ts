import type {
  PromiseDeconstructed,
} from './types';
import * as errors from '../errors';
import { StreamId } from '@/types';


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

function toStreamId(array: Uint8Array): bigint {
  const header = array[0];
  const prefix = header >> 6;
  const dv = new DataView(array.buffer, array.byteOffset, array.byteLength);

  let streamId: bigint;

  switch (prefix) {
    case 0b00:
      streamId = BigInt(dv.getUint8(0));
    case 0b01:
      streamId = BigInt(dv.getUint16(0, false));
    case 0b10:
      streamId = BigInt(dv.getUint32(0, false));
    case 0b11:
      streamId = dv.getBigUint64(0, false);
  }
  return streamId!;
}

function fromStreamId(streamId: StreamId): Uint8Array {
  const id = streamId as bigint;
  let prefix: number;
  if (id <= 0xFF) {
    prefix = 0b00;
  }
  else if (id <= 0xFFFF) {
    prefix = 0b01;
  }
  else if (id <= 0xFFFFFFFF) {
    prefix = 0b10;
  }
  else {
    prefix = 0b11;
  }
  const array = new Uint8Array(1 << prefix);
  const dv = new DataView(array.buffer, array.byteOffset, array.byteLength);
  switch (prefix) {
    case 0b00:
      dv.setUint8(0, Number(id));
    case 0b01:
      dv.setUint16(0, Number(id), false)
    case 0b10:
      dv.setUint32(0, Number(id), false);
    case 0b11:
      dv.setBigUint64(0, id, false);
  }
  return array;
}

export {
  never,
  promise,
  toStreamId,
  fromStreamId,
};
