import type { StreamId } from '@/types';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { fc, testProp } from '@fast-check/jest';
import WebSocketStream from '@/WebSocketStream';
import WebSocketConnection from '@/WebSocketConnection';
import * as events from '@/events';
import { promise, StreamType } from '@/utils';
import * as config from '@/config';
import * as testUtils from './utils';

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
          data.at(0) === StreamType.CLOSE ||
          data.at(0) === StreamType.ERROR
        ) {
          return;
        }
        stream = await WebSocketStream.createWebSocketStream({
          streamId,
          bufferSize: config.clientDefault.streamBufferSize,
          connection: instance.connectedConnection!,
          logger: logger2,
        });
        instance.connectedConnection!.dispatchEvent(
          new events.WebSocketConnectionStreamEvent({
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

  async function createStreamPair(connection1, connection2) {
    const stream1 = await WebSocketStream.createWebSocketStream({
      streamId: streamIdCounter as StreamId,
      bufferSize: config.clientDefault.streamBufferSize,
      connection: connection1,
      logger: logger1,
    });
    const createStream2Prom = promise<WebSocketStream>();
    connection2.addEventListener(
      'connectionStream',
      (e: events.WebSocketConnectionStreamEvent) => {
        createStream2Prom.resolveP(e.detail);
      },
      { once: true },
    );
    const stream2 = await createStream2Prom.p;
    streamIdCounter++;
    return [stream1, stream2];
  }
  testProp(
    'single write within buffer size',
    [fc.uint8Array({ maxLength: config.clientDefault.streamBufferSize })],
    async (data) => {
      const [stream1, stream2] = await createStreamPair(
        connection1,
        connection2,
      );

      const stream1Readable = stream1.readable;
      const stream2Writable = stream2.writable;

      const writer = stream2Writable.getWriter();
      const reader = stream1Readable.getReader();

      const writeProm = (async () => {
        await writer.write(data);
        await writer.close();
      })();

      const readChunks: Array<Uint8Array> = [];
      const readProm = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          readChunks.push(value);
        }
      })();

      await Promise.all([writeProm, readProm]);

      expect(readChunks).toEqual([data]);

      await stream1.destroy();
    },
  );
  testProp(
    'single write outside buffer size',
    [fc.uint8Array()],
    async (data) => {
      const [stream1, stream2] = await createStreamPair(
        connection1,
        connection2,
      );

      const stream1Readable = stream1.readable;
      const stream2Writable = stream2.writable;

      const writer = stream2Writable.getWriter();
      const reader = stream1Readable.getReader();

      const writeProm = (async () => {
        await writer.write(data);
        await writer.close();
      })();

      const readChunks: Array<Uint8Array> = [];
      const readProm = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          readChunks.push(value);
        }
      })();

      await Promise.all([writeProm, readProm]);

      expect(testUtils.concatUInt8Array(...readChunks)).toEqual(data);

      await stream1.destroy();
    },
  );
  testProp(
    'multiple writes within buffer size',
    [fc.array(fc.uint8Array({maxLength: config.clientDefault.streamBufferSize}))],
    async (data) => {
      const [stream1, stream2] = await createStreamPair(
        connection1,
        connection2,
      );

      const stream1Readable = stream1.readable;
      const stream2Writable = stream2.writable;

      const writer = stream2Writable.getWriter();
      const reader = stream1Readable.getReader();

      const writeProm = (async () => {
        for (const chunk of data) {
          await writer.write(chunk);
        }
        await writer.close();
      })();

      const readChunks: Array<Uint8Array> = [];
      const readProm = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          readChunks.push(value);
        }
      })();

      await Promise.all([writeProm, readProm]);

      expect(testUtils.concatUInt8Array(...readChunks)).toEqual(
        testUtils.concatUInt8Array(...data),
      );

      await stream1.destroy();
    },
  );
  testProp(
    'multiple writes outside buffer size',
    [fc.array(fc.uint8Array())],
    async (data) => {
      const [stream1, stream2] = await createStreamPair(
        connection1,
        connection2,
      );

      const stream1Readable = stream1.readable;
      const stream2Writable = stream2.writable;

      const writer = stream2Writable.getWriter();
      const reader = stream1Readable.getReader();

      const writeProm = (async () => {
        for (const chunk of data) {
          await writer.write(chunk);
        }
        await writer.close();
      })();

      const readChunks: Array<Uint8Array> = [];
      const readProm = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          readChunks.push(value);
        }
      })();

      await Promise.all([writeProm, readProm]);

      expect(testUtils.concatUInt8Array(...readChunks)).toEqual(
        testUtils.concatUInt8Array(...data),
      );

      await stream1.destroy();
    },
  );
});
