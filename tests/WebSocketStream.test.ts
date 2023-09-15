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

type StreamOptions = Partial<
  Parameters<typeof WebSocketStream.createWebSocketStream>[0]
>;

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

let streamIdCounter = 0n;

jest.mock('@/WebSocketConnection', () => {
  return jest.fn().mockImplementation((streamOptions: StreamOptions = {}) => {
    const instance = new EventTarget() as EventTarget & {
      peerConnection: WebSocketConnection | undefined;
      connectTo: (connection: WebSocketConnection) => void;
      send: (data: Uint8Array) => Promise<void>;
      streamNew: () => Promise<WebSocketStream>;
      streamMap: Map<StreamId, WebSocketStream>;
    };
    instance.peerConnection = undefined;
    instance.connectTo = (peerConnection: any) => {
      instance.peerConnection = peerConnection;
      peerConnection.peerConnection = instance;
    };
    instance.streamMap = new Map<StreamId, WebSocketStream>();
    instance.streamNew = async () => {
      const stream = await WebSocketStream.createWebSocketStream({
        streamId: streamIdCounter as StreamId,
        bufferSize: STREAM_BUFFER_SIZE,
        connection: instance as any,
        logger: logger1,
        ...streamOptions,
      });
      stream.addEventListener(
        events.EventWebSocketStreamDestroyed.name,
        () => {
          instance.streamMap.delete(stream.streamId);
        },
        { once: true },
      );
      instance.streamMap.set(stream.streamId, stream);
      streamIdCounter++;
      return stream;
    };
    instance.send = async (array: Uint8Array | Array<Uint8Array>) => {
      let data: Uint8Array;
      if (ArrayBuffer.isView(array)) {
        data = array;
      } else {
        data = messageUtils.concatUInt8Array(...array);
      }
      const { data: streamId, remainder } = messageUtils.parseStreamId(data);
      let stream = instance.peerConnection!.streamMap.get(streamId);
      if (stream == null) {
        const type = remainder.at(0);
        if (type !== StreamMessageType.Ack) {
          return;
        }
        stream = await WebSocketStream.createWebSocketStream({
          streamId,
          bufferSize: STREAM_BUFFER_SIZE,
          connection: instance.peerConnection!,
          logger: logger2,
          ...streamOptions,
        });
        stream.addEventListener(
          events.EventWebSocketStreamDestroyed.name,
          () => {
            instance.peerConnection!.streamMap.delete(streamId);
          },
          { once: true },
        );
        instance.peerConnection!.streamMap.set(stream.streamId, stream);
        instance.peerConnection!.dispatchEvent(
          new events.EventWebSocketConnectionStream({
            detail: stream,
          }),
        );
      }
      await stream.streamRecv(remainder);
    };
    return instance;
  });
});

const connectionMock = jest.mocked(WebSocketConnection, true);

describe(WebSocketStream.name, () => {
  beforeEach(async () => {
    connectionMock.mockClear();
  });

  async function createConnectionPair(
    streamOptions: StreamOptions = {},
  ): Promise<[WebSocketConnection, WebSocketConnection]> {
    const connection1 = new (WebSocketConnection as any)(streamOptions);
    const connection2 = new (WebSocketConnection as any)(streamOptions);
    (connection1 as any).connectTo(connection2);
    return [connection1, connection2];
  }

  async function createStreamPairFrom(
    connection1: WebSocketConnection,
    connection2: WebSocketConnection,
  ): Promise<[WebSocketStream, WebSocketStream]> {
    const stream1 = await connection1.streamNew();
    const createStream2Prom = promise<WebSocketStream>();
    connection2.addEventListener(
      events.EventWebSocketConnectionStream.name,
      (e: events.EventWebSocketConnectionStream) => {
        createStream2Prom.resolveP(e.detail);
      },
      { once: true },
    );
    const stream2 = await createStream2Prom.p;
    return [stream1, stream2];
  }

  async function createStreamPair(streamOptions: StreamOptions = {}) {
    const [connection1, connection2] = await createConnectionPair(
      streamOptions,
    );
    return createStreamPairFrom(connection1, connection2);
  }

  test('should create stream', async () => {
    const streams = await createStreamPair();
    expect(streams.length).toEqual(2);
    for (const stream of streams) {
      await stream.destroy();
    }
  });
  test('destroying stream should clean up on both ends while streams are used', async () => {
    const [connection1, connection2] = await createConnectionPair();
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
          { once: true },
        );
      },
    );

    for (let i = 0; i < streamsNum; i++) {
      const stream = await connection1.streamNew();
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
  test('should propagate errors over stream for writable', async () => {
    const testReason = Symbol('TestReason');
    const codeToReason = (type, code: bigint) => {
      switch (code) {
        case 4002n:
          return testReason;
        default:
          return new Error(`${type.toString()} ${code.toString()}`);
      }
    };
    const reasonToCode = (type, reason) => {
      if (reason === testReason) return 4002n;
      return 0n;
    };
    const [stream1, stream2] = await createStreamPair({
      codeToReason,
      reasonToCode,
    });

    const stream1Readable = stream1.readable;
    const stream2Writable = stream2.writable;
    await stream2Writable.abort(testReason);
    await expect(stream1Readable.getReader().read()).rejects.toBe(testReason);
    await expect(stream2Writable.getWriter().write()).rejects.toBe(testReason);
  });
  testProp(
    'should send data over stream - single write within buffer size',
    [fc.uint8Array({ maxLength: STREAM_BUFFER_SIZE })],
    async (data) => {
      data = new Uint8Array(0);
      const [stream1, stream2] = await createStreamPair();

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
      const [stream1, stream2] = await createStreamPair();

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
      const [stream1, stream2] = await createStreamPair();

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
      const [stream1, stream2] = await createStreamPair();

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
      const [stream1, stream2] = await createStreamPair();

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
      const streams = await createStreamPair();

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
  test('streams can be cancelled after data sent', async () => {
    const cancelReason = Symbol('CancelReason');
    const codeToReason = (type, code: bigint) => {
      switch (code) {
        case 4001n:
          return cancelReason;
        default:
          return new Error(`${type.toString()} ${code.toString()}`);
      }
    };
    const reasonToCode = (_type, reason) => {
      if (reason === cancelReason) return 4001n;
      return 0n;
    };
    const [_stream1, stream2] = await createStreamPair({
      codeToReason,
      reasonToCode,
    });

    const writer = stream2.writable.getWriter();
    await writer.write(new Uint8Array(2));
    writer.releaseLock();
    await stream2.cancel(cancelReason);

    await expect(stream2.readable.getReader().read()).rejects.toBe(
      cancelReason,
    );
    await expect(stream2.writable.getWriter().write()).rejects.toBe(
      cancelReason,
    );
  });
  test('streams can be cancelled with no data sent', async () => {
    const cancelReason = Symbol('CancelReason');
    const codeToReason = (type, code: bigint) => {
      switch (code) {
        case 4001n:
          return cancelReason;
        default:
          return new Error(`${type.toString()} ${code.toString()}`);
      }
    };
    const reasonToCode = (_type, reason) => {
      if (reason === cancelReason) return 4001n;
      return 0n;
    };
    const [_stream1, stream2] = await createStreamPair({
      codeToReason,
      reasonToCode,
    });

    await stream2.cancel(cancelReason);

    await expect(stream2.readable.getReader().read()).rejects.toBe(
      cancelReason,
    );
    await expect(stream2.writable.getWriter().write()).rejects.toBe(
      cancelReason,
    );
  });
  test('streams can be cancelled concurrently after data sent', async () => {
    const [stream1, stream2] = await createStreamPair();

    const writer = stream2.writable.getWriter();
    await writer.write(new Uint8Array(2));

    const reader = stream1.readable.getReader();
    reader.releaseLock();

    await Promise.all([writer.close(), stream1.writable.close()]);
  });
  // Test('stream can error when blocked on data', async () => {
  //   const [stream1, stream2] = await createStreamPair();

  //   const message = new Uint8Array(STREAM_BUFFER_SIZE * 2);

  //   const stream1Writer = stream1.writable.getWriter();
  //   void stream1Writer.write(message);
  //   stream1Writer.releaseLock();

  //   const stream2Writer = stream2.writable.getWriter();
  //   void stream2Writer.write(message);
  //   stream2Writer.releaseLock();

  //   await Promise.all([
  //     stream1Writer.abort(Error('some error')),
  //     stream1Writer.abort(Error('some error')),
  //   ]);
  // });
});
