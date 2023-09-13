import type { ConnectionMessage, StreamMessage } from '@/message';
import { testProp } from '@fast-check/jest';
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
} from '@/message';
import {
  connectionMessageArb,
  streamIdArb,
  streamMessageAckPayloadArb,
  streamMessageArb,
  streamMessageClosePayloadArb,
  streamMessageErrorPayloadArb,
  streamMessageTypeArb,
  varIntArb,
} from './utils';

describe('StreamMessage', () => {
  testProp('should parse/generate VarInt', [varIntArb], (varInt) => {
    const parsedVarInt = parseVarInt(generateVarInt(varInt));
    expect(parsedVarInt.data).toBe(varInt);
    expect(parsedVarInt.remainder).toHaveLength(0);
  });
  testProp('should parse/generate StreamId', [streamIdArb], (streamId) => {
    const parsedStreamId = parseStreamId(generateStreamId(streamId));
    expect(parsedStreamId.data).toBe(streamId);
    expect(parsedStreamId.remainder).toHaveLength(0);
  });
  testProp(
    'should parse/generate StreamMessageType',
    [streamMessageTypeArb],
    (streamMessageType) => {
      const parsedStreamMessageType = parseStreamMessageType(
        generateStreamMessageType(streamMessageType),
      );
      expect(parsedStreamMessageType.data).toBe(streamMessageType);
      expect(parsedStreamMessageType.remainder).toHaveLength(0);
    },
  );
  testProp(
    'should parse/generate StreamMessageAckPayload',
    [streamMessageAckPayloadArb],
    (ackPayload) => {
      const parsedAckPayload = parseStreamMessageAckPayload(
        generateStreamMessageAckPayload(ackPayload),
      );
      expect(parsedAckPayload.data).toBe(ackPayload);
      expect(parsedAckPayload.remainder).toHaveLength(0);
    },
  );
  testProp(
    'should parse/generate StreamMessageClosePayload',
    [streamMessageClosePayloadArb],
    (closePayload) => {
      const parsedClosePayload = parseStreamMessageClosePayload(
        generateStreamMessageClosePayload(closePayload),
      );
      expect(parsedClosePayload.data).toBe(closePayload);
      expect(parsedClosePayload.remainder).toHaveLength(0);
    },
  );
  testProp(
    'should parse/generate StreamMessageErrorPayload',
    [streamMessageErrorPayloadArb],
    (errorPayload) => {
      const parsedClosePayload = parseStreamMessageErrorPayload(
        generateStreamMessageErrorPayload(errorPayload),
      );
      expect(parsedClosePayload.data).toEqual(errorPayload);
      expect(parsedClosePayload.remainder).toHaveLength(0);
    },
  );
  testProp(
    'should parse/generate StreamMessage',
    [streamMessageArb],
    (streamMessage) => {
      const generatedStreamMessage = generateStreamMessage(
        streamMessage as StreamMessage,
      );
      const parsedStreamMessage = parseStreamMessage(generatedStreamMessage);
      expect(parsedStreamMessage).toEqual(streamMessage);
    },
  );
  testProp(
    'should parse/generate ConnectionMessage',
    [connectionMessageArb],
    (connectionMessage) => {
      const generatedConnectionMessage = generateConnectionMessage(
        connectionMessage as ConnectionMessage,
      );
      const parsedConnectionMessage = parseConnectionMessage(
        generatedConnectionMessage,
      );
      expect(parsedConnectionMessage).toEqual(connectionMessage);
    },
  );
});
