import type { StreamId, VarInt } from '@/message';
import { fc } from '@fast-check/jest';
import { StreamMessageType, StreamShutdown } from '@/message';

function fcBuffer(contraints?: fc.IntArrayConstraints) {
  return fc.uint8Array(contraints).map((data) => {
    const buff = Buffer.allocUnsafe(data.length);
    buff.set(data);
    return buff;
  });
}

const varIntArb = fc.bigInt({
  min: 0n,
  max: 2n ** 62n - 1n,
}) as fc.Arbitrary<VarInt>;

const streamIdArb = varIntArb as fc.Arbitrary<StreamId>;

const streamShutdownArb = fc.constantFrom(
  StreamShutdown.Read,
  StreamShutdown.Write,
);

const streamMessageTypeArb = fc.constantFrom(
  StreamMessageType.Ack,
  StreamMessageType.Data,
  StreamMessageType.Close,
  StreamMessageType.Error,
);

const streamMessageAckPayloadArb = fc.integer({ min: 0, max: 2 ** 32 - 1 });

const streamMessageClosePayloadArb = streamShutdownArb;

const streamMessageErrorPayloadArb = fc.record({
  shutdown: streamShutdownArb,
  code: varIntArb,
});

const streamMessageAckArb = fc.record({
  type: fc.constant(StreamMessageType.Ack),
  payload: streamMessageAckPayloadArb,
});

const streamMessageDataArb = fc.record({
  type: fc.constant(StreamMessageType.Data),
  payload: fcBuffer()
});

const streamMessageCloseArb = fc.record({
  type: fc.constant(StreamMessageType.Close),
  payload: streamMessageClosePayloadArb,
});

const streamMessageErrorArb = fc.record({
  type: fc.constant(StreamMessageType.Error),
  payload: streamMessageErrorPayloadArb,
});

const streamMessageArb = fc.oneof(
  streamMessageAckArb,
  streamMessageDataArb,
  streamMessageCloseArb,
  streamMessageErrorArb,
);

const connectionMessageArb = streamIdArb.chain((streamId) => {
  return streamMessageArb.map((streamMessage) => {
    return {
      streamId,
      ...streamMessage,
    };
  });
});

export {
  fcBuffer,
  varIntArb,
  streamIdArb,
  streamShutdownArb,
  streamMessageTypeArb,
  streamMessageAckPayloadArb,
  streamMessageClosePayloadArb,
  streamMessageErrorPayloadArb,
  streamMessageAckArb,
  streamMessageDataArb,
  streamMessageCloseArb,
  streamMessageErrorArb,
  streamMessageArb,
  connectionMessageArb,
};
