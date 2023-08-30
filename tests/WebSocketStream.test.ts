import { StreamId } from "@/types";
import WebSocketStream from "@/WebSocketStream";
import WebSocketConnection from "@/WebSocketConnection";
import * as events from "@/events";
import { promise } from "@/utils";
import { fc, testProp } from "@fast-check/jest";
import * as testUtils from './utils';

const DEFAULT_BUFFER_SIZE = 1024;

jest.mock('@/WebSocketConnection', () => {
  return jest.fn().mockImplementation((
  ) => {
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
        stream = await WebSocketStream.createWebSocketStream({
          streamId,
          bufferSize: DEFAULT_BUFFER_SIZE,
          connection: instance.connectedConnection!,
        });
        instance.connectedConnection!.dispatchEvent(new events.WebSocketConnectionStreamEvent({
          detail: stream,
        }));
      }
      stream.streamRecv(data);
    };
    return instance;
  });
});

const connectionMock = jest.mocked(WebSocketConnection, true);

describe(WebSocketStream.name, () => {
  let connection1: WebSocketConnection;
  let connection2: WebSocketConnection;
  beforeEach(async () => {
    connectionMock.mockClear();
    connection1 = new (WebSocketConnection as any)();
    connection2 = new (WebSocketConnection as any)();
    (connection1 as any).connectTo(connection2);
  });

  async function createStreamPair(connection1, connection2) {
    const stream1 = await WebSocketStream.createWebSocketStream({
      streamId: 0n as StreamId,
      bufferSize: DEFAULT_BUFFER_SIZE,
      connection: connection1
    });
    const createStream2Prom = promise<WebSocketStream>();
    connection2.addEventListener("connectionStream", (e: events.WebSocketConnectionStreamEvent) => {
      createStream2Prom.resolveP(e.detail);
    }, { once: true });
    const stream2 = await createStream2Prom.p;
    return [stream1, stream2];
  }
  // testProp(
  //   'normal',
  //   [fc.infiniteStream(fc.uint8Array({minLength: 1, maxLength: DEFAULT_BUFFER_SIZE}))],
  //   async (iterable) => {

  //     const writingTest = async () => {
  //       const stream2Writable = stream2.writable;
  //       const stream = testUtils.toReadableStream(iterable);
  //       await stream.pipeTo(stream2Writable);
  //     }

  //     const readingTest = async () => {
  //       const stream1Readable = stream1.readable;
  //       await stream1Readable.pipeTo([]);
  //     }

  //     await Promise.all([writingTest(), readingTest()]);

  //     // const stream2Writable = stream2.writable;
  //     // const buffer = new Uint8Array(2);
  //     // const writeProm = stream2Writable.getWriter().write(buffer);
  //     // await stream1Readable.getReader().read();
  //     // await writeProm;
  //     // await stream1.destroy();
  //   }
  // );
  test(
    'normal',
    async () => {
      const [stream1, stream2] = await createStreamPair(connection1, connection2);

      const buffer = new Uint8Array(DEFAULT_BUFFER_SIZE);
      testUtils.randomBytes(buffer);

      const stream1Readable = stream1.readable;
      const stream2Writable = stream2.writable;
      const writeProm = stream2Writable.getWriter().write(buffer);
      await stream1Readable.getReader().read();
      await writeProm;

      await stream1.destroy();
      await stream2.destroy();
    }
  );
});
