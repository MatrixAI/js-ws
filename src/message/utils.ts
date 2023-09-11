import type {
  ConnectionMessage,
  Parsed,
  StreamId,
  StreamMessage,
  VarInt,
} from './types';
import { never } from '@/utils';
import * as errors from './errors';

// Enums

const enum StreamMessageType {
  Data = 0,
  Ack = 1,
  Error = 2,
  Close = 3,
}

const enum StreamShutdown {
  Read = 0,
  Write = 1,
}

const StreamErrorCode = {
  Unknown: 0n as VarInt,
  ErrorReadableStreamParse: 1n as VarInt,
  ErrorReadableStreamBufferOverflow: 2n as VarInt,
} as const;

// Misc

function concatUInt8Array(...arrays: Array<Uint8Array>) {
  const totalLength = arrays.reduce((acc, val) => acc + val.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// VarInt

function parseVarInt(array: Uint8Array): Parsed<VarInt> {
  let streamId: bigint;

  // Get header and prefix
  const header = array.at(0);
  if (header == null) {
    throw new errors.ErrorStreamParse('VarInt header is too short');
  }
  const prefix = header >> 6;

  // Copy bytearray and remove prefix
  const arrayCopy = new Uint8Array(array.length);
  arrayCopy.set(array);
  arrayCopy[0] &= 0b00111111;

  const dv = new DataView(arrayCopy.buffer, arrayCopy.byteOffset);

  let readBytes = 0;

  try {
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
  } catch (e) {
    throw new errors.ErrorStreamParse('VarInt is too short');
  }
  return {
    data: streamId! as VarInt,
    remainder: array.subarray(readBytes),
  };
}

function generateVarInt(varInt: VarInt): Uint8Array {
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
  } else if (varInt < 0x4000000000000000n) {
    array = new Uint8Array(8);
    dv = new DataView(array.buffer);
    dv.setBigUint64(0, varInt);
    prefixMask = 0b11_000000;
  } else {
    throw new errors.ErrorStreamGenerate('VarInt too large');
  }

  let header = dv.getUint8(0);
  header |= prefixMask;
  dv.setUint8(0, header);

  return array;
}

const generateStreamId = generateVarInt as (streamId: StreamId) => Uint8Array;
const parseStreamId = parseVarInt as (array: Uint8Array) => Parsed<StreamId>;

// StreamMessage

function parseStreamMessageType(input: Uint8Array): Parsed<StreamMessageType> {
  const type = input.at(0);
  if (type == null) {
    throw new errors.ErrorStreamParse(
      'StreamMessage does not contain a StreamMessageType',
    );
  }
  switch (type) {
    case StreamMessageType.Ack:
    case StreamMessageType.Data:
    case StreamMessageType.Close:
    case StreamMessageType.Error:
      return {
        data: type,
        remainder: input.subarray(1),
      };
    default:
      throw new errors.ErrorStreamParse(
        `StreamMessage contains an invalid StreamMessageType: ${type}`,
      );
  }
}

function parseStreamMessageAckPayload(input: Uint8Array): Parsed<number> {
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input.byteLength < 4) {
    throw new errors.ErrorStreamParse('StreamMessageAckPayload is too short');
  }
  const payload = dv.getUint32(0, false);
  return {
    data: payload,
    remainder: input.subarray(4),
  };
}

function parseStreamMessageClosePayload(
  input: Uint8Array,
): Parsed<StreamShutdown> {
  const shutdown = input.at(0);
  if (shutdown == null) {
    throw new errors.ErrorStreamParse(
      'StreamMessageClosePayload does not contain a StreamShutdown',
    );
  }
  if (shutdown !== StreamShutdown.Read && shutdown !== StreamShutdown.Write) {
    throw new errors.ErrorStreamParse(
      `StreamMessageClosePayload contains an invalid StreamShutdown: ${shutdown}`,
    );
  }
  return {
    data: shutdown,
    remainder: input.subarray(1),
  };
}

function parseStreamMessageErrorPayload(
  input: Uint8Array,
): Parsed<{ shutdown: StreamShutdown; code: VarInt }> {
  let remainder = input;

  const shutdown = input.at(0);
  if (shutdown == null) {
    throw new errors.ErrorStreamParse(
      'StreamMessageErrorPayload does not contain a StreamShutdown',
    );
  }
  if (shutdown !== StreamShutdown.Read && shutdown !== StreamShutdown.Write) {
    throw new errors.ErrorStreamParse(
      `StreamMessageErrorPayload contains an invalid StreamShutdown: ${shutdown}`,
    );
  }
  remainder = remainder.subarray(1);

  const { data: code, remainder: postCodeRemainder } = parseVarInt(remainder);
  remainder = postCodeRemainder;

  return {
    data: {
      shutdown,
      code,
    },
    remainder,
  };
}

function parseStreamMessage(input: Uint8Array): StreamMessage {
  let remainder = input;

  const { data: type, remainder: postTypeRemainder } =
    parseStreamMessageType(remainder);
  remainder = postTypeRemainder;

  let payload: any;
  if (type === StreamMessageType.Ack) {
    const { data: ackPayload, remainder: postAckPayloadRemainder } =
      parseStreamMessageAckPayload(remainder);
    remainder = postAckPayloadRemainder;
    payload = ackPayload;
  } else if (type === StreamMessageType.Data) {
    payload = remainder;
  } else if (type === StreamMessageType.Close) {
    const { data: closePayload, remainder: postClosePayloadRemainder } =
      parseStreamMessageClosePayload(remainder);
    remainder = postClosePayloadRemainder;
    payload = closePayload;
  } else if (type === StreamMessageType.Error) {
    const { data: errorPayload, remainder: postErrorPayloadRemainder } =
      parseStreamMessageErrorPayload(remainder);
    remainder = postErrorPayloadRemainder;
    payload = errorPayload;
  } else {
    never();
  }

  return {
    type,
    payload,
  };
}

function generateStreamMessageType(type: StreamMessageType): Uint8Array {
  return new Uint8Array([type]);
}

function generateStreamMessageAckPayload(ackPayload: number): Uint8Array {
  if (ackPayload > 0xffffffff) {
    throw new errors.ErrorStreamGenerate(
      'StreamMessageAckPayload is too large',
    );
  }
  const array = new Uint8Array(4);
  const dv = new DataView(array.buffer);
  dv.setUint32(0, ackPayload, false);
  return array;
}

function generateStreamMessageClosePayload(
  closePayload: StreamShutdown,
): Uint8Array {
  return new Uint8Array([closePayload]);
}

function generateStreamMessageErrorPayload(errorPayload: {
  shutdown: StreamShutdown;
  code: VarInt;
}): Uint8Array {
  const generatedCode = generateVarInt(errorPayload.code);
  const array = new Uint8Array(1 + generatedCode.length);
  array[0] = errorPayload.shutdown;
  array.set(generatedCode, 1);
  return array;
}

function generateStreamMessage(input: StreamMessage, concat?: true): Uint8Array;
function generateStreamMessage(
  input: StreamMessage,
  concat: false,
): Array<Uint8Array>;
function generateStreamMessage(input: StreamMessage, concat = true) {
  const generatedType = generateStreamMessageType(input.type);
  let generatedPayload: Uint8Array;
  if (input.type === StreamMessageType.Ack) {
    generatedPayload = generateStreamMessageAckPayload(input.payload);
  } else if (input.type === StreamMessageType.Data) {
    generatedPayload = input.payload;
  } else if (input.type === StreamMessageType.Close) {
    generatedPayload = generateStreamMessageClosePayload(input.payload);
  } else if (input.type === StreamMessageType.Error) {
    generatedPayload = generateStreamMessageErrorPayload(input.payload);
  } else {
    never();
  }
  if (!concat) {
    return [generatedType, generatedPayload];
  }
  return concatUInt8Array(generatedType, generatedPayload);
}

// Connection Message

function parseConnectionMessage(input: Uint8Array): ConnectionMessage {
  const { data: streamId, remainder } = parseStreamId(input);
  const streamMessage = parseStreamMessage(remainder);
  return {
    streamId,
    ...streamMessage,
  };
}

function generateConnectionMessage(input: ConnectionMessage): Uint8Array {
  const generatedStreamId = generateStreamId(input.streamId);
  const generatedStreamMessage = generateStreamMessage(input);
  return concatUInt8Array(generatedStreamId, generatedStreamMessage);
}

export {
  StreamMessageType,
  StreamShutdown,
  StreamErrorCode,
  concatUInt8Array,
  parseVarInt,
  generateVarInt,
  parseStreamId,
  generateStreamId,
  parseStreamMessageType,
  parseStreamMessageAckPayload,
  parseStreamMessageClosePayload,
  parseStreamMessageErrorPayload,
  parseStreamMessage,
  generateStreamMessageType,
  generateStreamMessageAckPayload,
  generateStreamMessageClosePayload,
  generateStreamMessageErrorPayload,
  generateStreamMessage,
  parseConnectionMessage,
  generateConnectionMessage,
};
