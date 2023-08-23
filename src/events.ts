import WebSocketConnection from './WebSocketConnection';
import type WebSocketStream from './WebSocketStream';

// Server events

abstract class WebSocketServerEvent extends Event {}

class WebSocketServerConnectionEvent extends Event {
  public detail: WebSocketConnection;
  constructor(
    options: EventInit & {
      detail: WebSocketConnection;
    },
  ) {
    super('serverConnection', options);
    this.detail = options.detail;
  }
}

class WebSocketServerStartEvent extends Event {
  constructor(options?: EventInit) {
    super('serverStart', options);
  }
}

class WebSocketServerStopEvent extends Event {
  constructor(options?: EventInit) {
    super('serverStop', options);
  }
}

class WebSocketServerErrorEvent extends Event {
  public detail: Error;
  constructor(
    options: EventInit & {
      detail: Error;
    },
  ) {
    super('serverError', options);
    this.detail = options.detail;
  }
}

// Connection events

abstract class WebSocketConnectionEvent extends Event {}

class WebSocketConnectionStreamEvent extends WebSocketConnectionEvent {
  public detail: WebSocketStream;
  constructor(
    options: EventInit & {
      detail: WebSocketStream;
    },
  ) {
    super('connectionStream', options);
    this.detail = options.detail;
  }
}

class WebSocketConnectionStopEvent extends WebSocketConnectionEvent {
  constructor(options?: EventInit) {
    super('connectionStop', options);
  }
}

class WebSocketConnectionErrorEvent extends WebSocketConnectionEvent {
  public detail: Error;
  constructor(
    options: EventInit & {
      detail: Error;
    },
  ) {
    super('connectionError', options);
    this.detail = options.detail;
  }
}

export {
  WebSocketServerEvent, WebSocketServerConnectionEvent, WebSocketServerStartEvent, WebSocketServerStopEvent, WebSocketConnectionEvent, WebSocketConnectionStreamEvent, WebSocketConnectionStopEvent, WebSocketConnectionErrorEvent };
