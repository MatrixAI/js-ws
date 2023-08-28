import { StreamId } from "@/types";
import WebSocketStream from "@/WebSocketStream";
import WebSocketConnection from "@/WebSocketConnection";
import * as events from "@/events";
import { promise } from "@/utils";

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
  let stream1: WebSocketStream;
  let stream2: WebSocketStream;
  beforeEach(async () => {
    connectionMock.mockClear();
    connection1 = new (WebSocketConnection as any)();
    connection2 = new (WebSocketConnection as any)();
    (connection1 as any).connectTo(connection2);
    stream1 = await WebSocketStream.createWebSocketStream({
      streamId: 0n as StreamId,
      bufferSize: DEFAULT_BUFFER_SIZE,
      connection: connection1
    });
    const createStream2Prom = promise<WebSocketStream>();
    connection2.addEventListener("connectionStream", (e: events.WebSocketConnectionStreamEvent) => {
      createStream2Prom.resolveP(e.detail);
    });
    stream2 = await createStream2Prom.p;
  });
  test('buffering', async () => {
    const stream1Readable = stream1.readable;
    const stream2Writable = stream2.writable;
    const buffer = new Uint8Array(DEFAULT_BUFFER_SIZE+1);
    const writeProm = stream2Writable.getWriter().write(buffer);
    await stream1Readable.getReader().read()
    await writeProm;
  });
});
