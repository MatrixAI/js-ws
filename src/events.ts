import type WebSocketStream from './WebSocketStream';
import type WebSocketConnection from './WebSocketConnection';
import { AbstractEvent } from '@matrixai/events';

abstract class EventWebSocket<T = null> extends AbstractEvent<T> {}

// Client Events

abstract class EventWebSocketClient<T = null> extends EventWebSocket<T> {}

class EventWebSocketClientDestroy extends EventWebSocketClient {}

class EventWebSocketClientDestroyed extends EventWebSocketClient {}

class EventWebSocketClientError extends EventWebSocketClient<Error> {}

// Server events

abstract class EventWebSocketServer<T = null> extends EventWebSocket<T> {}

class EventWebSocketServerConnection extends EventWebSocketServer<WebSocketConnection> {}

class EventWebSocketServerStart extends EventWebSocketServer {}

class EventWebSocketServerStarted extends EventWebSocketServer {}

class EventWebSocketServerStop extends EventWebSocketServer {}

class EventWebSocketServerStopped extends EventWebSocketServer {}

class EventWebSocketServerError extends EventWebSocketServer<Error> {}

// Connection events

abstract class EventWebSocketConnection<T = null> extends EventWebSocket<T> {}

class EventWebSocketConnectionStream extends EventWebSocketConnection<WebSocketStream> {}

class EventWebSocketConnectionStart extends EventWebSocketConnection {}

class EventWebSocketConnectionStarted extends EventWebSocketConnection {}

class EventWebSocketConnectionStop extends EventWebSocketConnection {}

class EventWebSocketConnectionStopped extends EventWebSocketConnection {}

class EventWebSocketConnectionError extends EventWebSocketConnection<Error> {}

// Stream events

abstract class EventWebSocketStream<T = null> extends EventWebSocket<T> {}

class EventWebSocketStreamDestroy extends EventWebSocketStream {}

class EventWebSocketStreamDestroyed extends EventWebSocketStream {}

export {
  EventWebSocket,
  EventWebSocketClient,
  EventWebSocketClientError,
  EventWebSocketClientDestroy,
  EventWebSocketClientDestroyed,
  EventWebSocketServer,
  EventWebSocketServerConnection,
  EventWebSocketServerStart,
  EventWebSocketServerStarted,
  EventWebSocketServerStop,
  EventWebSocketServerStopped,
  EventWebSocketServerError,
  EventWebSocketConnection,
  EventWebSocketConnectionStream,
  EventWebSocketConnectionStart,
  EventWebSocketConnectionStarted,
  EventWebSocketConnectionStop,
  EventWebSocketConnectionStopped,
  EventWebSocketConnectionError,
  EventWebSocketStream,
  EventWebSocketStreamDestroy,
  EventWebSocketStreamDestroyed,
};
