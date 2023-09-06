import type { StreamId } from '@/message';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { fc, testProp } from '@fast-check/jest';
import WebSocketStream from '@/WebSocketStream';
import WebSocketConnection from '@/WebSocketConnection';
import * as events from '@/events';
import { promise } from '@/utils';
import * as utils from '@/utils';
import * as messageUtils from '@/message/utils';
import { StreamMessageType } from '@/message';

// Smaller buffer size for the sake of testing
const STREAM_BUFFER_SIZE = 64;

const logger1 = new Logger('stream 1', LogLevel.WARN, [
  new StreamHandler(
    formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
  ),
]);

const logger2 = new Logger('stream 2', LogLevel.WARN, [
  new StreamHandler(
    formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
  ),
]);

jest.mock('@/WebSocketConnection', () => {
  return jest.fn().mockImplementation(() => {
    const instance = new EventTarget() as EventTarget & {
      connectedConnection: WebSocketConnection | undefined;
      connectTo: (connection: WebSocketConnection) => void;
      streamSend: (streamId: StreamId, data: Uint8Array) => Promise<void>;
      streamMap: Map<StreamId, WebSocketStream>;
    };
    instance.connectedConnection = undefined;
    instance.connectTo = (connectedConnection: any) => {
      instance.connectedConnection = connectedConnection;
      connectedConnection.connectedConnection = instance;
    };
    instance.streamMap = new Map<StreamId, WebSocketStream>();
    instance.streamSend = async (streamId: StreamId, data: Uint8Array) => {
      let stream = instance.connectedConnection!.streamMap.get(streamId);
      if (stream == null) {
        if (
          data.at(0) === StreamMessageType.Close ||
          data.at(0) === StreamMessageType.Error
        ) {
          return;
        }
        stream = await WebSocketStream.createWebSocketStream({
          streamId,
          bufferSize: STREAM_BUFFER_SIZE,
          connection: instance.connectedConnection!,
          logger: logger2,
        });
        instance.connectedConnection!.dispatchEvent(
          new events.EventWebSocketConnectionStream({
            detail: stream,
          }),
        );
      }
      await stream.streamRecv(data);
    };
    return instance;
  });
});

const connectionMock = jest.mocked(WebSocketConnection, true);

describe(WebSocketStream.name, () => {
  let connection1: WebSocketConnection;
  let connection2: WebSocketConnection;
  let streamIdCounter = 0n;

  beforeEach(async () => {
    connectionMock.mockClear();
    streamIdCounter = 0n;
    connection1 = new (WebSocketConnection as any)();
    connection2 = new (WebSocketConnection as any)();
    (connection1 as any).connectTo(connection2);
  });

  async function createStreamPair(
    connection1: WebSocketConnection,
    connection2: WebSocketConnection,
  ) {
    const stream1 = await WebSocketStream.createWebSocketStream({
      streamId: streamIdCounter as StreamId,
      bufferSize: STREAM_BUFFER_SIZE,
      connection: connection1,
      logger: logger1,
    });
    const createStream2Prom = promise<WebSocketStream>();
    connection2.addEventListener(
      events.EventWebSocketConnectionStream.name,
      (e: events.EventWebSocketConnectionStream) => {
        createStream2Prom.resolveP(e.detail);
      },
      { once: true },
    );
    const stream2 = await createStream2Prom.p;
    streamIdCounter++;
    return [stream1, stream2];
  }
  test('should create stream', async () => {
    const streams = await createStreamPair(connection1, connection2);
    expect(streams.length).toEqual(2);
    for (const stream of streams) {
      await stream.destroy();
    }
  });
  test('destroying stream should clean up on both ends while streams are used', async () => {
    const streamsNum = 10;

    let streamCreatedCount = 0;
    let streamEndedCount = 0;
    const streamCreationProm = utils.promise();
    const streamEndedProm = utils.promise();

    const streams = new Array<WebSocketStream>();

    connection2.addEventListener(
      events.EventWebSocketConnectionStream.name,
      (event: events.EventWebSocketConnectionStream) => {
        const stream = event.detail;
        streamCreatedCount += 1;
        if (streamCreatedCount >= streamsNum) streamCreationProm.resolveP();
        stream.addEventListener(
          events.EventWebSocketStreamDestroyed.name,
          () => {
            streamEndedCount += 1;
            if (streamEndedCount >= streamsNum) streamEndedProm.resolveP();
          },
        );
      },
    );

    for (let i = 0; i < streamsNum; i++) {
      const stream = await WebSocketStream.createWebSocketStream({
        streamId: streamIdCounter as StreamId,
        bufferSize: STREAM_BUFFER_SIZE,
        connection: connection1,
        logger: logger1,
      });
      streamIdCounter++;
      streams.push(stream);
    }
    await streamCreationProm.p;
    await Promise.allSettled(streams.map((stream) => stream.destroy()));
    await streamEndedProm.p;
    expect(streamCreatedCount).toEqual(streamsNum);
    expect(streamEndedCount).toEqual(streamsNum);
    for (const stream of streams) {
      await stream.destroy();
    }
  });
  testProp(
    'should send data over stream - single write within buffer size',
    [fc.uint8Array({ maxLength: STREAM_BUFFER_SIZE })],
    async (data) => {
      const [stream1, stream2] = await createStreamPair(
        connection1,
        connection2,
      );

      const stream1Readable = stream1.readable;
      const stream2Writable = stream2.writable;

      const writer = stream2Writable.getWriter();
      const reader = stream1Readable.getReader();

      const writeF = async () => {
        await writer.write(data);
        await writer.close();
      };

      const readChunks: Array<Uint8Array> = [];
      const readF = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          readChunks.push(value);
        }
      };

      await Promise.all([writeF(), readF()]);

      expect(readChunks).toEqual([data]);

      await stream1.destroy();
      await stream2.destroy();
    },
  );
  testProp(
    'should send data over stream - single write outside buffer size',
    [fc.uint8Array({ minLength: STREAM_BUFFER_SIZE + 1 })],
    async (data) => {
      const [stream1, stream2] = await createStreamPair(
        connection1,
        connection2,
      );

      const stream1Readable = stream1.readable;
      const stream2Writable = stream2.writable;

      const writer = stream2Writable.getWriter();
      const reader = stream1Readable.getReader();

      const writeF = async () => {
        await writer.write(data);
        await writer.close();
      };

      const readChunks: Array<Uint8Array> = [];
      const readF = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          readChunks.push(value);
        }
      };

      await Promise.all([writeF(), readF()]);

      expect(messageUtils.concatUInt8Array(...readChunks)).toEqual(data);

      await stream1.destroy();
      await stream2.destroy();
    },
  );
  testProp(
    'should send data over stream - multiple writes within buffer size',
    [fc.array(fc.uint8Array({ maxLength: STREAM_BUFFER_SIZE }))],
    async (data) => {
      const [stream1, stream2] = await createStreamPair(
        connection1,
        connection2,
      );

      const stream1Readable = stream1.readable;
      const stream2Writable = stream2.writable;

      const writer = stream2Writable.getWriter();
      const reader = stream1Readable.getReader();

      const writeF = async () => {
        for (const chunk of data) {
          await writer.write(chunk);
        }
        await writer.close();
      };

      const readChunks: Array<Uint8Array> = [];
      const readProm = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          readChunks.push(value);
        }
      };

      await Promise.all([writeF(), readProm()]);

      expect(messageUtils.concatUInt8Array(...readChunks)).toEqual(
        messageUtils.concatUInt8Array(...data),
      );

      await stream1.destroy();
      await stream2.destroy();
    },
  );
  testProp(
    'should send data over stream - multiple writes outside buffer size',
    [fc.array(fc.uint8Array({ minLength: STREAM_BUFFER_SIZE + 1 }))],
    async (data) => {
      const [stream1, stream2] = await createStreamPair(
        connection1,
        connection2,
      );

      const stream1Readable = stream1.readable;
      const stream2Writable = stream2.writable;

      const writer = stream2Writable.getWriter();
      const reader = stream1Readable.getReader();

      const writeF = async () => {
        for (const chunk of data) {
          await writer.write(chunk);
        }
        await writer.close();
      };

      const readChunks: Array<Uint8Array> = [];
      const readF = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          readChunks.push(value);
        }
      };

      await Promise.all([writeF(), readF()]);

      expect(messageUtils.concatUInt8Array(...readChunks)).toEqual(
        messageUtils.concatUInt8Array(...data),
      );

      await stream1.destroy();
      await stream2.destroy();
    },
  );
  testProp(
    'should send data over stream - multiple writes within and outside buffer size',
    [
      fc.array(
        fc.oneof(
          fc.uint8Array({ minLength: STREAM_BUFFER_SIZE + 1 }),
          fc.uint8Array({ maxLength: STREAM_BUFFER_SIZE }),
        ),
      ),
    ],
    async (data) => {
      const [stream1, stream2] = await createStreamPair(
        connection1,
        connection2,
      );

      const stream1Readable = stream1.readable;
      const stream2Writable = stream2.writable;

      const writer = stream2Writable.getWriter();
      const reader = stream1Readable.getReader();

      const writeF = async () => {
        for (const chunk of data) {
          await writer.write(chunk);
        }
        await writer.close();
      };

      const readChunks: Array<Uint8Array> = [];
      const readF = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          readChunks.push(value);
        }
      };

      await Promise.all([writeF(), readF()]);

      expect(messageUtils.concatUInt8Array(...readChunks)).toEqual(
        messageUtils.concatUInt8Array(...data),
      );

      await stream1.destroy();
      await stream2.destroy();
    },
  );
  testProp(
    'should send data over stream - simultaneous multiple writes within and outside buffer size',
    [
      fc.array(
        fc.oneof(
          fc.uint8Array({ minLength: STREAM_BUFFER_SIZE + 1 }),
          fc.uint8Array({ maxLength: STREAM_BUFFER_SIZE }),
        ),
      ),
      fc.array(
        fc.oneof(
          fc.uint8Array({ minLength: STREAM_BUFFER_SIZE + 1 }),
          fc.uint8Array({ maxLength: STREAM_BUFFER_SIZE }),
        ),
      ),
    ],
    async (...data) => {
      const streams = await createStreamPair(connection1, connection2);

      const readProms: Array<Promise<Array<Uint8Array>>> = [];
      const writeProms: Array<Promise<void>> = [];

      for (const [i, stream] of streams.entries()) {
        const reader = stream.readable.getReader();
        const writer = stream.writable.getWriter();
        const writeF = async () => {
          for (const chunk of data[i]) {
            await writer.write(chunk);
          }
          await writer.close();
        };
        const readF = async () => {
          const readChunks: Array<Uint8Array> = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            readChunks.push(value);
          }
          return readChunks;
        };
        readProms.push(readF());
        writeProms.push(writeF());
      }
      await Promise.all(writeProms);
      const readResults = await Promise.all(readProms);

      data.reverse();
      for (const [i, readResult] of readResults.entries()) {
        expect(messageUtils.concatUInt8Array(...readResult)).toEqual(
          messageUtils.concatUInt8Array(...data[i]),
        );
      }

      for (const stream of streams) {
        await stream.destroy();
      }
    },
  );
});
