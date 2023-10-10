import type WebSocketStream from './WebSocketStream';
import type WebSocketConnection from './WebSocketConnection';
import type {
  ErrorWebSocketConnectionInternal,
  ErrorWebSocketConnectionKeepAliveTimeOut,
  ErrorWebSocketConnectionLocal,
  ErrorWebSocketConnectionPeer,
  ErrorWebSocketStreamInternal,
  ErrorWebSocketStreamLocalRead,
  ErrorWebSocketStreamLocalWrite,
  ErrorWebSocketStreamPeerRead,
  ErrorWebSocketStreamPeerWrite,
} from './errors';
import type { StreamId, StreamMessageType } from './message';
import { AbstractEvent } from '@matrixai/events';

abstract class EventWebSocket<T = null> extends AbstractEvent<T> {}

// Client Events

abstract class EventWebSocketClient<T = null> extends EventWebSocket<T> {}

class EventWebSocketClientDestroy extends EventWebSocketClient {}

class EventWebSocketClientDestroyed extends EventWebSocketClient {}

class EventWebSocketClientError extends EventWebSocketClient<Error> {}

class EventWebSocketClientClose extends EventWebSocketClient {}

// Server events

abstract class EventWebSocketServer<T = null> extends EventWebSocket<T> {}

class EventWebSocketServerConnection extends EventWebSocketServer<WebSocketConnection> {}

class EventWebSocketServerStart extends EventWebSocketServer {}

class EventWebSocketServerStarted extends EventWebSocketServer {}

class EventWebSocketServerStop extends EventWebSocketServer {}

class EventWebSocketServerStopped extends EventWebSocketServer {}

class EventWebSocketServerError extends EventWebSocketServer<Error> {}

class EventWebSocketServerClose extends EventWebSocketServer<Error> {}

// Connection events

abstract class EventWebSocketConnection<T = null> extends EventWebSocket<T> {}

class EventWebSocketConnectionStream extends EventWebSocketConnection<WebSocketStream> {}

class EventWebSocketConnectionStart extends EventWebSocketConnection {}

class EventWebSocketConnectionStarted extends EventWebSocketConnection {}

class EventWebSocketConnectionStop extends EventWebSocketConnection {}

class EventWebSocketConnectionStopped extends EventWebSocketConnection {}

class EventWebSocketConnectionError extends EventWebSocketConnection<
  | ErrorWebSocketConnectionLocal<unknown>
  | ErrorWebSocketConnectionPeer<unknown>
  | ErrorWebSocketConnectionKeepAliveTimeOut<unknown>
  | ErrorWebSocketConnectionInternal<unknown>
> {}

class EventWebSocketConnectionClose extends EventWebSocketConnection<
  | ErrorWebSocketConnectionLocal<unknown>
  | ErrorWebSocketConnectionPeer<unknown>
  | ErrorWebSocketConnectionKeepAliveTimeOut<unknown>
> {}

// Stream events

abstract class EventWebSocketStream<T = null> extends EventWebSocket<T> {}

class EventWebSocketStreamStart extends EventWebSocketStream {}

class EventWebSocketStreamStarted extends EventWebSocketStream {}

class EventWebSocketStreamStop extends EventWebSocketStream {}

class EventWebSocketStreamStopped extends EventWebSocketStream {}

// Note that you can close the readable side, and give a code
// You can close the writable side, and give a code
// Neither of which represents an "error" for the WebSocket stream error?
// Or does it?
// Because one could argue either way, and then have a way to separate
// Intenral errors from non-internal errors

/**
 * WebSocket stream encountered an error.
 * Unlike WebSocketConnection, you can just have graceful close without any error event at all.
 * This is because streams can just be finished with no code.
 * But WebSocketConnection closure always comes with some error code and reason, even if the code is 0.
 */
class EventWebSocketStreamError extends EventWebSocketStream<
  | ErrorWebSocketStreamLocalRead<unknown> // I may send out errors on both stop sending (shutdown read) and reset stream (shutdown write)
  | ErrorWebSocketStreamLocalWrite<unknown> // I may send out errors on both stop sending (shutdown read) and reset stream (shutdown write)
  | ErrorWebSocketStreamPeerRead<unknown> // I may receive errors on both stop sending (shutdown read) and reset stream (shutdown write)
  | ErrorWebSocketStreamPeerWrite<unknown> // I may receive errors on both stop sending (shutdown read) and reset stream (shutdown write)
  | ErrorWebSocketStreamInternal<unknown>
> {}

/**
 * WebSocket stream readable side was closed
 * Local means I closed my readable side - there must be an error code.
 * Peer means the peer closed my readable side by closing their writable side - there may not be an error code.
 */
class EventWebSocketStreamCloseRead extends EventWebSocketStream<
  | ErrorWebSocketStreamLocalRead<unknown>
  | ErrorWebSocketStreamPeerRead<unknown>
  | undefined
> {}

/**
 * WebSocket stream writable side was closed
 * Local means I closed my writable side - there may not be an error code.
 * Peer means the peer closed my writable side by closing their readable side - there must be an error code.
 */
class EventWebSocketStreamCloseWrite extends EventWebSocketStream<
  | ErrorWebSocketStreamLocalWrite<unknown>
  | ErrorWebSocketStreamPeerWrite<unknown>
  | undefined
> {}

class EventWebSocketStreamSend extends EventWebSocketStream {
  msg: Uint8Array | Array<Uint8Array>;
  streamId: StreamId;
  messageType: StreamMessageType;
  constructor(
    options: EventInit & {
      msg: Uint8Array | Array<Uint8Array>;
      streamId: StreamId;
      messageType: StreamMessageType;
    },
  ) {
    super(EventWebSocketStreamSend.name, options, arguments);
    this.msg = options.msg;
    this.streamId = options.streamId;
    this.messageType = options.messageType;
  }
}

export {
  EventWebSocket,
  EventWebSocketClient,
  EventWebSocketClientError,
  EventWebSocketClientDestroy,
  EventWebSocketClientDestroyed,
  EventWebSocketClientClose,
  EventWebSocketServer,
  EventWebSocketServerConnection,
  EventWebSocketServerStart,
  EventWebSocketServerStarted,
  EventWebSocketServerStop,
  EventWebSocketServerStopped,
  EventWebSocketServerError,
  EventWebSocketServerClose,
  EventWebSocketConnection,
  EventWebSocketConnectionStream,
  EventWebSocketConnectionStart,
  EventWebSocketConnectionStarted,
  EventWebSocketConnectionStop,
  EventWebSocketConnectionStopped,
  EventWebSocketConnectionError,
  EventWebSocketConnectionClose,
  EventWebSocketStream,
  EventWebSocketStreamStart,
  EventWebSocketStreamStarted,
  EventWebSocketStreamStop,
  EventWebSocketStreamStopped,
  EventWebSocketStreamError,
  EventWebSocketStreamCloseRead,
  EventWebSocketStreamCloseWrite,
  EventWebSocketStreamSend,
};
