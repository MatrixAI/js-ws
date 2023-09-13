import type { IncomingMessage, ServerResponse } from 'http';
import type tls from 'tls';
import type {
  Host,
  Port,
  StreamCodeToReason,
  StreamReasonToCode,
  WebSocketConfig,
} from './types';
import type { AbstractEvent } from '@matrixai/events';
import https from 'https';
import {
  StartStop,
  status,
  running,
  ready,
} from '@matrixai/async-init/dist/StartStop';
import Logger from '@matrixai/logger';
import * as ws from 'ws';
import { EventAll, EventDefault } from '@matrixai/events';
import * as errors from './errors';
import * as events from './events';
import { never, promise } from './utils';
import WebSocketConnection from './WebSocketConnection';
import { serverDefault } from './config';
import WebSocketConnectionMap from './WebSocketConnectionMap';

interface WebSocketServer extends StartStop {}
/**
 * You must provide an error handler `addEventListener('error')`.
 * Otherwise, errors will just be ignored.
 *
 * Events:
 * - {@link events.EventWebSocketServerStart},
 * - {@link events.EventWebSocketServerStarted},
 * - {@link events.EventWebSocketServerStop},
 * - {@link events.EventWebSocketServerStopped},
 * - {@link events.EventWebSocketServerConnection}
 * - {@link events.EventWebSocketServerError}
 * - {@link events.EventWebSocketConnectionStream}
 * - {@link events.EventWebSocketConnectionStart}
 * - {@link events.EventWebSocketConnectionStarted}
 * - {@link events.EventWebSocketConnectionStop}
 * - {@link events.EventWebSocketConnectionStopped}
 * - {@link events.EventWebSocketConnectionError} - can occur due to a timeout too
 * - {@link events.EventWebSocketConnectionClose}
 * - {@link events.EventWebSocketStreamDestroy}
 * - {@link events.EventWebSocketStreamDestroyed}
 */
@StartStop({
  eventStart: events.EventWebSocketServerStart,
  eventStarted: events.EventWebSocketServerStarted,
  eventStop: events.EventWebSocketServerStop,
  eventStopped: events.EventWebSocketServerStopped,
})
class WebSocketServer extends EventTarget {
  protected logger: Logger;
  protected config: WebSocketConfig & {
    key: string;
    cert: string;
    ca?: string;
  };
  protected server: https.Server;
  protected webSocketServer: ws.WebSocketServer;
  protected reasonToCode: StreamReasonToCode | undefined;
  protected codeToReason: StreamCodeToReason | undefined;
  public readonly connectionMap: WebSocketConnectionMap =
    new WebSocketConnectionMap();

  protected _port: number;
  protected _host: string;

  protected handleWebSocketConnection = (
    event:
      | AbstractEvent
      | EventDefault<AbstractEvent>
      | EventAll<AbstractEvent>,
  ) => {
    if (event instanceof EventAll || event instanceof EventDefault) {
      this.dispatchEvent(event.detail.clone());
    } else {
      this.dispatchEvent(event.clone());
    }
  };

  /**
   *
   * @param logger
   * @param config
   */
  constructor({
    config,
    reasonToCode,
    codeToReason,
    logger,
  }: {
    config: Partial<WebSocketConfig> & {
      key: string;
      cert: string;
      ca?: string;
    };
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    logger?: Logger;
  }) {
    super();
    const wsConfig = {
      ...serverDefault,
      ...config,
    };
    this.logger = logger ?? new Logger(this.constructor.name);
    this.config = wsConfig;
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;
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
      key: this.config.key,
      cert: this.config.cert,
      ca: this.config.ca,
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
    this.logger.info(`Started ${this.constructor.name}`);
  }

  public async stop({
    force = false,
  }: { force?: boolean } = {}): Promise<void> {
    this.logger.info(`Stopping ${this.constructor.name}`);
    const destroyProms: Array<Promise<void>> = [];
    for (const webSocketConnection of this.connectionMap.values()) {
      destroyProms.push(
        webSocketConnection.stop({
          errorMessage: 'cleaning up connections',
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
    this.logger.info(`Stopped ${this.constructor.name}`);
  }

  @ready(new errors.ErrorWebSocketServerNotRunning())
  public getPort(): number {
    return this._port;
  }

  @ready(new errors.ErrorWebSocketServerNotRunning())
  public getHost(): string {
    return this._host;
  }

  @ready(new errors.ErrorWebSocketServerNotRunning())
  public updateConfig(
    config: Partial<WebSocketConfig> & {
      key?: string;
      cert?: string;
      ca?: string;
    },
  ): void {
    const tlsServer = this.server as tls.Server;
    const wsConfig = {
      ...this.config,
      ...config,
    };
    tlsServer.setSecureContext(wsConfig);
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
    const connectionId = this.connectionMap.allocateId();
    const connection = new WebSocketConnection({
      type: 'server',
      connectionId: connectionId,
      remoteInfo: {
        host: (httpSocket.remoteAddress ?? '') as Host,
        port: (httpSocket.remotePort ?? 0) as Port,
      },
      socket: webSocket,
      config: this.config,
      reasonToCode: this.reasonToCode,
      codeToReason: this.codeToReason,
      logger: this.logger.getChild(
        `${WebSocketConnection.name} ${connectionId}`,
      ),
      server: this,
    });

    await connection.start({
      timer: this.config.connectTimeoutTime,
    });

    // Handling connection events
    connection.addEventListener(
      events.EventWebSocketConnectionStopped.name,
      (event: events.EventWebSocketConnectionStopped) => {
        connection.removeEventListener(
          EventAll.name,
          this.handleWebSocketConnection,
        );
        this.handleWebSocketConnection(event);
      },
      { once: true },
    );

    connection.addEventListener(
      EventDefault.name,
      this.handleWebSocketConnection,
    );

    this.dispatchEvent(
      new events.EventWebSocketServerConnection({
        detail: connection,
      }),
    );
  };

  /**
   * Used to trigger stopping if the underlying server fails
   */
  protected closeHandler = async () => {
    if (this[running] && this[status] !== 'stopping') {
      await this.stop({ force: true });
    }
  };

  /**
   * Used to propagate error conditions
   */
  protected errorHandler = (e: Error) => {
    this.dispatchEvent(
      new events.EventWebSocketServerError({
        detail: new errors.ErrorWebSocketServer(
          'An error occured on the underlying server',
          {
            cause: e,
          },
        ),
      }),
    );
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
