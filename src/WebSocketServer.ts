import type { IncomingMessage, ServerResponse } from 'http';
import type tls from 'tls';
import type { Host, Port, WebSocketConfig } from './types';
import https from 'https';
import { startStop, status } from '@matrixai/async-init';
import Logger from '@matrixai/logger';
import * as ws from 'ws';
import Counter from 'resource-counter';
import * as errors from './errors';
import * as webSocketEvents from './events';
import { never, promise } from './utils';
import WebSocketConnection from './WebSocketConnection';
import { serverDefault } from './config';
import * as utils from './utils';

/**
 * Events:
 * - start
 * - stop
 * - connection
 */
interface WebSocketServer extends startStop.StartStop {}
@startStop.StartStop()
class WebSocketServer extends EventTarget {
  protected logger: Logger;
  protected config: WebSocketConfig;
  protected server: https.Server;
  protected webSocketServer: ws.WebSocketServer;
  protected _port: number;
  protected _host: string;
  public readonly connectionIdCounter = new Counter(0);
  public readonly connectionMap: Map<number, WebSocketConnection> = new Map();

  protected handleWebSocketConnectionEvents = (
    event: webSocketEvents.WebSocketConnectionEvent,
  ) => {
    if (event instanceof webSocketEvents.WebSocketConnectionErrorEvent) {
      this.dispatchEvent(
        new webSocketEvents.WebSocketConnectionErrorEvent({
          detail: event.detail,
        }),
      );
    } else if (event instanceof webSocketEvents.WebSocketConnectionStopEvent) {
      this.dispatchEvent(new webSocketEvents.WebSocketConnectionStopEvent());
    } else if (
      event instanceof webSocketEvents.WebSocketConnectionStreamEvent
    ) {
      this.dispatchEvent(
        new webSocketEvents.WebSocketConnectionStreamEvent({
          detail: event.detail,
        }),
      );
    } else {
      utils.never();
    }
  };

  /**
   *
   * @param logger
   * @param config
   */
  constructor({
    config,
    logger,
  }: {
    config: Partial<WebSocketConfig> & {
      key: string;
      cert: string;
      ca?: string;
    };
    logger?: Logger;
  }) {
    super();
    const wsConfig = {
      ...serverDefault,
      ...config,
    };
    this.logger = logger ?? new Logger(this.constructor.name);
    this.config = wsConfig;
  }

  public async start({
    host,
    port = 0,
  }: {
    host?: string;
    port?: number;
  } = {}): Promise<void> {
    this.logger.info(`Starting ${this.constructor.name}`);
    this.server = https.createServer({
      ...this.config,
      requestTimeout: this.config.connectTimeoutTime,
    });
    this.webSocketServer = new ws.WebSocketServer({
      server: this.server,
    });

    this.webSocketServer.on('connection', this.connectionHandler);
    this.webSocketServer.on('close', this.closeHandler);
    this.server.on('close', this.closeHandler);
    this.webSocketServer.on('error', this.errorHandler);
    this.server.on('error', this.errorHandler);
    this.server.on('request', this.requestHandler);

    const listenProm = promise<void>();
    this.server.listen(port, host, listenProm.resolveP);
    await listenProm.p;
    const address = this.server.address();
    if (address == null || typeof address === 'string') never();
    this._port = address.port;
    this.logger.debug(`Listening on port ${this._port}`);
    this._host = address.address ?? '127.0.0.1';
    this.dispatchEvent(new webSocketEvents.WebSocketServerStartEvent());
    this.logger.info(`Started ${this.constructor.name}`);
  }

  public async stop({ force = false }: { force?: boolean }): Promise<void> {
    this.logger.info(`Stopping ${this.constructor.name}`);
    const destroyProms: Array<Promise<void>> = [];
    for (const webSocketConnection of this.connectionMap.values()) {
      destroyProms.push(
        webSocketConnection.stop({
          force,
        }),
      );
    }
    this.logger.debug('Awaiting connections to destroy');
    await Promise.all(destroyProms);
    this.logger.debug('All connections destroyed');
    // Close the server by closing the underlying socket
    const wssCloseProm = promise<void>();
    this.webSocketServer.close((e) => {
      if (e == null || e.message === 'The server is not running') {
        wssCloseProm.resolveP();
      } else {
        wssCloseProm.rejectP(e);
      }
    });
    await wssCloseProm.p;
    const serverCloseProm = promise<void>();
    this.server.close((e) => {
      if (e == null || e.message === 'Server is not running.') {
        serverCloseProm.resolveP();
      } else {
        serverCloseProm.rejectP(e);
      }
    });
    await serverCloseProm.p;

    this.webSocketServer.off('connection', this.connectionHandler);
    this.webSocketServer.off('close', this.closeHandler);
    this.server.off('close', this.closeHandler);
    this.webSocketServer.off('error', this.errorHandler);
    this.server.off('error', this.errorHandler);
    this.server.on('request', this.requestHandler);

    this.dispatchEvent(new webSocketEvents.WebSocketServerStopEvent());
    this.logger.info(`Stopped ${this.constructor.name}`);
  }

  @startStop.ready(new errors.ErrorWebSocketServerNotRunning())
  public getPort(): number {
    return this._port;
  }

  @startStop.ready(new errors.ErrorWebSocketServerNotRunning())
  public getHost(): string {
    return this._host;
  }

  @startStop.ready(new errors.ErrorWebSocketServerNotRunning())
  public updateConfig(
    config: Partial<WebSocketConfig> & {
      key?: string;
      cert?: string;
      ca?: string;
    },
  ): void {
    const tlsServer = this.server as tls.Server;
    tlsServer.setSecureContext({
      key: config.key,
      cert: config.cert,
      ca: config.ca,
    });
    const wsConfig = {
      ...this.config,
      ...config,
    };
    this.config = wsConfig;
  }

  /**
   * Handles the creation of the `ReadableWritablePair` and provides it to the
   * StreamPair handler.
   */
  protected connectionHandler = async (
    webSocket: ws.WebSocket,
    request: IncomingMessage,
  ) => {
    const httpSocket = request.connection;
    const connectionId = this.connectionIdCounter.allocate();
    const connection = await WebSocketConnection.createWebSocketConnection({
      type: 'server',
      connectionId: connectionId,
      remoteInfo: {
        host: (httpSocket.remoteAddress ?? '') as Host,
        port: (httpSocket.remotePort ?? 0) as Port,
      },
      config: this.config,
      socket: webSocket,
      logger: this.logger.getChild(
        `${WebSocketConnection.name} ${connectionId}`,
      ),
      server: this,
    });

    // Handling connection events
    connection.addEventListener(
      'connectionError',
      this.handleWebSocketConnectionEvents,
    );
    connection.addEventListener(
      'connectionStream',
      this.handleWebSocketConnectionEvents,
    );
    connection.addEventListener(
      'streamDestroy',
      this.handleWebSocketConnectionEvents,
    );
    connection.addEventListener(
      'connectionStop',
      (event) => {
        connection.removeEventListener(
          'connectionError',
          this.handleWebSocketConnectionEvents,
        );
        connection.removeEventListener(
          'connectionStream',
          this.handleWebSocketConnectionEvents,
        );
        connection.removeEventListener(
          'streamDestroy',
          this.handleWebSocketConnectionEvents,
        );
        this.handleWebSocketConnectionEvents(event);
      },
      { once: true },
    );

    this.dispatchEvent(
      new webSocketEvents.WebSocketServerConnectionEvent({
        detail: connection,
      }),
    );
  };

  /**
   * Used to trigger stopping if the underlying server fails
   */
  protected closeHandler = async () => {
    if (this[status] == null || this[status] === 'stopping') {
      this.logger.debug('close event but already stopping');
      return;
    }
    this.logger.debug('close event, forcing stop');
    await this.stop({ force: true });
  };

  /**
   * Used to propagate error conditions
   */
  protected errorHandler = (e: Error) => {
    this.logger.error(e);
  };

  /**
   * Will tell any normal HTTP request to upgrade
   */
  protected requestHandler = (_req, res: ServerResponse) => {
    res
      .writeHead(426, '426 Upgrade Required', {
        connection: 'Upgrade',
        upgrade: 'websocket',
      })
      .end('426 Upgrade Required');
  };
}

export default WebSocketServer;
