import type { StreamId } from '@/message';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { fc, testProp } from '@fast-check/jest';
import WebSocketStream from '@/WebSocketStream';
import WebSocketConnection from '@/WebSocketConnection';
import * as events from '@/events';
import * as utils from '@/utils';
import * as messageUtils from '@/message/utils';
import { StreamMessageType } from '@/message';
import * as messageTestUtils from './message/utils';

type StreamOptions = Partial<
  ConstructorParameters<typeof WebSocketStream>[0]
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
      const stream = new WebSocketStream({
        initiated: 'local',
        streamId: streamIdCounter as StreamId,
        bufferSize: STREAM_BUFFER_SIZE,
        connection: instance as any,
        logger: logger1,
        ...streamOptions,
      });
      stream.addEventListener(events.EventWebSocketStreamSend.name, (evt: any) => {
        instance.send(evt.msg);
      });
      stream.addEventListener(
        events.EventWebSocketStreamStopped.name,
        () => {
          instance.streamMap.delete(stream.streamId);
        },
        { once: true },
      );
      instance.streamMap.set(stream.streamId, stream);
      await stream.start();
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
        if (!(remainder.at(0) === 0 && remainder.at(1) === StreamMessageType.Ack)) {
          return;
        }
        stream = new WebSocketStream({
          initiated: 'peer',
          streamId,
          bufferSize: STREAM_BUFFER_SIZE,
          connection: instance.peerConnection!,
          logger: logger2,
          ...streamOptions,
        });
        stream.addEventListener(events.EventWebSocketStreamSend.name, (evt: any) => {
          instance.peerConnection!.send(evt.msg)
        });
        stream.addEventListener(
          events.EventWebSocketStreamStopped.name,
          () => {
            instance.peerConnection!.streamMap.delete(streamId);
          },
          { once: true },
        );
        instance.peerConnection!.streamMap.set(stream.streamId, stream);
        await stream.start();
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
    const createStream2Prom = utils.promise<WebSocketStream>();
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
      await stream.stop();
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
          events.EventWebSocketStreamStopped.name,
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
    await Promise.allSettled(streams.map((stream) => stream.stop()));
    await streamEndedProm.p;
    expect(streamCreatedCount).toEqual(streamsNum);
    expect(streamEndedCount).toEqual(streamsNum);

    for (const stream of streams) {
      await stream.stop();
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
    await expect(stream1Readable.getReader().read()).rejects.toHaveProperty('cause', testReason);
    await expect(stream2Writable.getWriter().write()).rejects.toBe(testReason);
  });
  testProp(
    'should send data over stream - single write within buffer size',
    [messageTestUtils.fcBuffer({ maxLength: STREAM_BUFFER_SIZE })],
    async (data) => {
      const [stream1, stream2] = await createStreamPair();

      const stream1Readable = stream1.readable;
      const stream2Writable = stream2.writable;
      stream1.writable.close();

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

      expect(messageUtils.concatUInt8Array(...readChunks)).toEqual(messageUtils.concatUInt8Array(data));

      await stream1.stop();
      await stream2.stop();
    },
  );
  testProp(
    'should send data over stream - single write outside buffer size',
    [messageTestUtils.fcBuffer({ minLength: STREAM_BUFFER_SIZE + 1 })],
    async (data) => {
      const [stream1, stream2] = await createStreamPair();

      const stream1Readable = stream1.readable;
      const stream2Writable = stream2.writable;
      stream1.writable.close();

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

      await stream1.stop();
      await stream2.stop();
    },
  );
  testProp(
    'should send data over stream - multiple writes within buffer size',
    [fc.array(messageTestUtils.fcBuffer({ maxLength: STREAM_BUFFER_SIZE }))],
    async (data) => {
      const [stream1, stream2] = await createStreamPair();

      const stream1Readable = stream1.readable;
      const stream2Writable = stream2.writable;
      stream1.writable.close();

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

      await stream1.stop();
      await stream2.stop();
    },
  );
  testProp(
    'should send data over stream - multiple writes outside buffer size',
    [fc.array(messageTestUtils.fcBuffer({ minLength: STREAM_BUFFER_SIZE + 1 }))],
    async (data) => {
      const [stream1, stream2] = await createStreamPair();

      const stream1Readable = stream1.readable;
      const stream2Writable = stream2.writable;
      stream1.writable.close();

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

      await stream1.stop();
      await stream2.stop();
    },
  );
  testProp(
    'should send data over stream - multiple writes within and outside buffer size',
    [
      fc.array(
        fc.oneof(
          messageTestUtils.fcBuffer({ minLength: STREAM_BUFFER_SIZE + 1 }),
          messageTestUtils.fcBuffer({ maxLength: STREAM_BUFFER_SIZE }),
        ),
      ),
    ],
    async (data) => {
      const [stream1, stream2] = await createStreamPair();

      const stream1Readable = stream1.readable;
      const stream2Writable = stream2.writable;
      stream1.writable.close();

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

      await stream1.stop();
      await stream2.stop();
    },
  );
  testProp(
    'should send data over stream - simultaneous multiple writes within and outside buffer size',
    [
      fc.array(
        fc.oneof(
          messageTestUtils.fcBuffer({ minLength: STREAM_BUFFER_SIZE + 1 }),
          messageTestUtils.fcBuffer({ maxLength: STREAM_BUFFER_SIZE }),
        ),
      ),
      fc.array(
        fc.oneof(
          messageTestUtils.fcBuffer({ minLength: STREAM_BUFFER_SIZE + 1 }),
          messageTestUtils.fcBuffer({ maxLength: STREAM_BUFFER_SIZE }),
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
        await stream.stop();
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

    await expect(stream2.readable.getReader().read()).rejects.toHaveProperty('cause', cancelReason)
    await expect(stream2.writable.getWriter().write()).rejects.toHaveProperty('cause', cancelReason);
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

    await expect(stream2.readable.getReader().read()).rejects.toHaveProperty('cause', cancelReason)
    await expect(stream2.writable.getWriter().write()).rejects.toHaveProperty('cause', cancelReason)
  });
  test('streams can be cancelled concurrently after data sent', async () => {
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
    const [stream1, stream2] = await createStreamPair({
      codeToReason,
      reasonToCode,
    });

    const writer = stream2.writable.getWriter();
    await writer.write(Buffer.alloc(STREAM_BUFFER_SIZE - 1));
    writer.releaseLock();

    stream1.cancel(cancelReason);
    stream2.cancel(cancelReason);

    await expect(stream2.readable.getReader().read()).rejects.toHaveProperty('cause', cancelReason);
    await expect(stream2.writable.getWriter().write()).rejects.toHaveProperty('cause', cancelReason);
    await expect(stream1.readable.getReader().read()).rejects.toHaveProperty('cause', cancelReason);
    await expect(stream1.writable.getWriter().write()).rejects.toHaveProperty('cause', cancelReason);
  });
  test('stream will end when waiting for more data', async () => {
    // Needed to check that the pull based reading of data doesn't break when we
    // temporarily run out of data to read
    const [stream1, stream2] = await createStreamPair();
    const message = Buffer.alloc(STREAM_BUFFER_SIZE - 1);
    const clientWriter = stream1.writable.getWriter();
    await clientWriter.write(message);

    // Drain the readable buffer
    const serverReader = stream2.readable.getReader();
    serverReader.releaseLock();

    // Closing stream with no buffered data should be responsive
    await clientWriter.close();
    await stream2.writable.close();

    // Both streams are destroyed even without reading till close
    await Promise.all([stream1.closedP, stream2.closedP]);
  });
  test('stream can error when blocked on data', async () => {
    // This checks that if the readable web-stream is full and not pulling data,
    // we will still respond to an error in the readable stream

    const [stream1, stream2] = await createStreamPair();

    const message = new Uint8Array(STREAM_BUFFER_SIZE);

    const stream1Writer = stream1.writable.getWriter();
    await stream1Writer.write(message);

        // Fill up buffers to block reads from pulling
    const stream2Writer = stream2.writable.getWriter();
    await stream2Writer.write(message);
    await stream2Writer.write(message);

    await stream1Writer.abort(new Error('Some Error'));
    await stream2Writer.abort(new Error('Some Error'));

    await Promise.all([stream1.closedP, stream2.closedP]);
  });
});
