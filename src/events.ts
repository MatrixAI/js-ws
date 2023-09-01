import type WebSocketStream from './WebSocketStream';
import type WebSocketConnection from './WebSocketConnection';
import { AbstractEvent } from '@matrixai/events';

abstract class EventWebSocket<T = null> extends AbstractEvent<T> {}

// Client Events

abstract class EventWebSocketClient<T = null> extends EventWebSocket<T> {}

class EventWebSocketClientDestroy extends EventWebSocketClient {}

class EventWebSocketClientError extends EventWebSocketClient<Error> {}

// Server events

abstract class EventWebSocketServer<T = null> extends EventWebSocket<T> {}

class EventWebSocketServerConnection extends EventWebSocketServer<WebSocketConnection> {}

class EventWebSocketServerStart extends EventWebSocketServer {}

class EventWebSocketServerStop extends EventWebSocketServer {}

class EventWebSocketServerError extends EventWebSocketServer<Error> {}

// Connection events

abstract class EventWebSocketConnection<T = null> extends EventWebSocket<T> {}

class EventWebSocketConnectionStream extends EventWebSocketConnection<WebSocketStream> {}

class EventWebSocketConnectionStop extends EventWebSocketConnection {}

class EventWebSocketConnectionError extends EventWebSocketConnection<Error> {}

// Stream events

abstract class EventWebSocketStream<T = null> extends EventWebSocket<T> {}

class EventWebSocketStreamDestroy extends EventWebSocketStream {}

export {
  EventWebSocket,
  EventWebSocketClient,
  EventWebSocketClientError,
  EventWebSocketClientDestroy,
  EventWebSocketServer,
  EventWebSocketServerConnection,
  EventWebSocketServerStart,
  EventWebSocketServerStop,
  EventWebSocketServerError,
  EventWebSocketConnection,
  EventWebSocketConnectionStream,
  EventWebSocketConnectionStop,
  EventWebSocketConnectionError,
  EventWebSocketStream,
  EventWebSocketStreamDestroy,
};
