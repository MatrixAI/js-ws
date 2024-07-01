import type { ConnectionMessage, StreamMessage } from '#message/index.js';
import { test } from '@fast-check/jest';
import {
  connectionMessageArb,
  streamIdArb,
  streamMessageAckPayloadArb,
  streamMessageArb,
  streamMessageClosePayloadArb,
  streamMessageErrorPayloadArb,
  streamMessageTypeArb,
  varIntArb,
} from './utils.js';
import {
  generateConnectionMessage,
  generateStreamId,
  generateStreamMessage,
  generateStreamMessageAckPayload,
  generateStreamMessageClosePayload,
  generateStreamMessageErrorPayload,
  generateStreamMessageType,
  generateVarInt,
  parseConnectionMessage,
  parseStreamId,
  parseStreamMessage,
  parseStreamMessageAckPayload,
  parseStreamMessageClosePayload,
  parseStreamMessageErrorPayload,
  parseStreamMessageType,
  parseVarInt,
} from '#message/index.js';

describe('StreamMessage', () => {
  test.prop([varIntArb])(`should parse/generate VarInt`, (varInt) => {
    const parsedVarInt = parseVarInt(generateVarInt(varInt));
    expect(parsedVarInt.data).toBe(varInt);
    expect(parsedVarInt.remainder).toHaveLength(0);
  });
  test.prop([streamIdArb])('should parse/generate StreamId', (streamId) => {
    const parsedStreamId = parseStreamId(generateStreamId(streamId));
    expect(parsedStreamId.data).toBe(streamId);
    expect(parsedStreamId.remainder).toHaveLength(0);
  });
  test.prop([streamMessageTypeArb])(
    'should parse/generate StreamMessageType',
    (streamMessageType) => {
      const parsedStreamMessageType = parseStreamMessageType(
        generateStreamMessageType(streamMessageType),
      );
      expect(parsedStreamMessageType.data).toBe(streamMessageType);
      expect(parsedStreamMessageType.remainder).toHaveLength(0);
    },
  );
  test.prop([streamMessageAckPayloadArb])(
    'should parse/generate StreamMessageAckPayload',
    (ackPayload) => {
      const parsedAckPayload = parseStreamMessageAckPayload(
        generateStreamMessageAckPayload(ackPayload),
      );
      expect(parsedAckPayload.data).toBe(ackPayload);
      expect(parsedAckPayload.remainder).toHaveLength(0);
    },
  );
  test.prop([streamMessageClosePayloadArb])(
    'should parse/generate StreamMessageClosePayload',
    (closePayload) => {
      const parsedClosePayload = parseStreamMessageClosePayload(
        generateStreamMessageClosePayload(closePayload),
      );
      expect(parsedClosePayload.data).toBe(closePayload);
      expect(parsedClosePayload.remainder).toHaveLength(0);
    },
  );
  test.prop([streamMessageErrorPayloadArb])(
    'should parse/generate StreamMessageErrorPayload',
    (errorPayload) => {
      const parsedClosePayload = parseStreamMessageErrorPayload(
        generateStreamMessageErrorPayload(errorPayload),
      );
      expect(parsedClosePayload.data).toEqual(errorPayload);
      expect(parsedClosePayload.remainder).toHaveLength(0);
    },
  );
  test.prop([streamMessageArb])(
    'should parse/generate StreamMessage',
    (streamMessage) => {
      const generatedStreamMessage = generateStreamMessage(
        streamMessage as StreamMessage,
      );
      const parsedStreamMessage = parseStreamMessage(generatedStreamMessage);
      expect(parsedStreamMessage.payload).toEqual(streamMessage.payload);
    },
  );
  test.prop([connectionMessageArb])(
    'should parse/generate ConnectionMessage',
    (connectionMessage) => {
      const generatedConnectionMessage = generateConnectionMessage(
        connectionMessage as ConnectionMessage,
      );
      const parsedConnectionMessage = parseConnectionMessage(
        generatedConnectionMessage,
      );
      expect(parsedConnectionMessage.payload).toEqual(
        connectionMessage.payload,
      );
    },
  );
});
