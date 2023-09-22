import type { IncomingMessage, ServerResponse } from 'http';
import type tls from 'tls';
import type {
  Host,
  Port,
  PromiseDeconstructed,
  StreamCodeToReason,
  StreamReasonToCode,
  WebSocketConfig,
  WebSocketServerConfigInput,
} from './types';
import type { EventAll } from '@matrixai/events';
import type { DetailedPeerCertificate, TLSSocket } from 'tls';
import https from 'https';
import { AbstractEvent } from '@matrixai/events';
import {
  StartStop,
  status,
  running,
  ready,
} from '@matrixai/async-init/dist/StartStop';
import Logger from '@matrixai/logger';
import * as ws from 'ws';
import { EventDefault } from '@matrixai/events';
import * as errors from './errors';
import * as events from './events';
import * as utils from './utils';
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
 * - {@link events.EventWebSocketConnection} - all dispatched events from {@link WebSocketConnection}
 */
@StartStop({
  eventStart: events.EventWebSocketServerStart,
  eventStarted: events.EventWebSocketServerStarted,
  eventStop: events.EventWebSocketServerStop,
  eventStopped: events.EventWebSocketServerStopped,
})
class WebSocketServer {
  /**
   * Determines whether the socket is injected or not
   */
  public readonly isServerShared: boolean;

  /**
   * Custom reason to code converter for new connections.
   */
  public reasonToCode?: StreamReasonToCode;
  /**
   * Custom code to reason converted for new connections.
   */
  public codeToReason?: StreamCodeToReason;

  protected logger: Logger;
  /**
   * Configuration for new connections.
   */
  protected config: WebSocketConfig;
  /**
   * Connection timeout for new connections.
   */
  public connectTimeoutTime?: number;

  public readonly connectionMap: WebSocketConnectionMap =
    new WebSocketConnectionMap();
  protected server: https.Server;
  protected webSocketServer: ws.WebSocketServer;
  protected webSocketServerClosed = false;

  protected _closed: boolean = false;
  public readonly closedP: Promise<void>;
  protected resolveClosedP: () => void;

  protected _port: number;
  protected _host: string;

  /**
   * This must be attached once.
   */
  protected handleEventWebSocketServerError = async (
    evt: events.EventWebSocketServerError,
  ) => {
    const error = evt.detail;
    this.logger.error(utils.formatError(error));
  };

  protected handleEventWebSocketServerClose = async () => {
    // Close means we are "closing", but error state has occurred
    // Not that we have actually closed
    // That's different from socket close event which means "fully" closed
    // We would call that `Closed` event, not `Close` event
    this.webSocketServer.off('close', this.handleWebSocketServerClosed);
    this.server.off('close', this.handleServerClosed);

    if (this.isServerShared) {
      if (this.webSocketServerClosed) {
        this.resolveClosedP();
      }
      this.webSocketServer.close(() => this.resolveClosedP());
      await this.closedP;
    } else {
      if (!this.webSocketServerClosed) {
        const wsClosedP = utils.promise();
        this.webSocketServer.close(() => wsClosedP.resolveP());
        await wsClosedP.p;
      }
      if (!this.server.listening) {
        this.resolveClosedP();
      }
      this.server.close(() => this.resolveClosedP());
      await this.closedP;
    }

    this._closed = true;
    if (this[running]) {
      // If stop fails, it is a software bug
      await this.stop({ force: true });
    }
  };

  /**
   * This must be attached once.
   */
  protected handleEventWebSocketConnectionStopped = (
    evt: events.EventWebSocketConnectionStopped,
  ) => {
    const WebSocketConnection = evt.target as WebSocketConnection;
    this.connectionMap.delete(WebSocketConnection.connectionId);
  };

  protected handleEventWebSocketConnection = (evt: EventAll) => {
    if (evt.detail instanceof AbstractEvent) {
      this.dispatchEvent(evt.detail.clone());
    }
  };

  /**
   * Used to trigger stopping if the underlying server fails
   */
  protected handleServerClosed = async () => {
    this.dispatchEvent(new events.EventWebSocketServerClose());
  };

  protected handleWebSocketServerClosed = async () => {
    this.webSocketServerClosed = true;
    this.dispatchEvent(new events.EventWebSocketServerClose());
  };

  /**
   * Used to propagate error conditions
   */
  protected handleServerError = (e: Error) => {
    this.dispatchEvent(
      new events.EventWebSocketServerError({
        detail: new errors.ErrorWebSocketServerInternal(
          'An error occured on the underlying server',
          {
            cause: e,
          },
        ),
      }),
    );
    this.dispatchEvent(new events.EventWebSocketServerClose());
  };

  /**
   * Handles the creation of the `ReadableWritablePair` and provides it to the
   * StreamPair handler.
   */
  protected handleServerConnection = async (
    webSocket: ws.WebSocket,
    request: IncomingMessage,
  ) => {

    const httpSocket = request.connection;
    const connectionId = this.connectionMap.allocateId();
    const peerCert = (httpSocket as TLSSocket).getPeerCertificate(true);
    const peerCertChain = utils.toPeerCertChain(peerCert);
    const localCACertsChain = utils.collectPEMs(this.config.ca).map(utils.pemToDER);
    const localCertsChain = utils.collectPEMs(this.config.cert).map(utils.pemToDER);
    const connection = new WebSocketConnection({
      type: 'server',
      connectionId: connectionId,
      meta: {
        remoteHost: httpSocket.remoteAddress ?? '',
        remotePort: httpSocket.remotePort ?? 0,
        localHost: httpSocket.localAddress ?? '',
        localPort: httpSocket.localPort ?? 0,
        localCACertsChain,
        localCertsChain,
        remoteCertsChain: peerCertChain,
      },
      socket: webSocket,
      config: { ...this.config },
      reasonToCode: this.reasonToCode,
      codeToReason: this.codeToReason,
      logger: this.logger.getChild(
        `${WebSocketConnection.name} ${connectionId}`,
      ),
    });
    this.connectionMap.add(connection);
    connection.addEventListener(
      events.EventWebSocketConnectionStopped.name,
      this.handleEventWebSocketConnectionStopped,
    );
    try {
      await connection.start({
        timer: this.connectTimeoutTime,
      });
    } catch (e) {
      connection.removeEventListener(
        events.EventWebSocketConnectionStopped.name,
        this.handleEventWebSocketConnectionStopped,
      );
      this.connectionMap.delete(connection.connectionId);
      this.dispatchEvent(
        new events.EventWebSocketServerError({
          detail: e,
        }),
      );
    }
    this.dispatchEvent(
      new events.EventWebSocketServerConnection({
        detail: connection,
      }),
    );
  };

  /**
   * @param opts
   * @param opts.config - configuration for new connections.
   * @param opts.server - if not provided, a new server will be created.
   * @param opts.reasonToCode - reasonToCode for stream errors
   * @param opts.codeToReason - codeToReason for stream errors
   * @param opts.logger - default logger is used if not provided
   */
  constructor({
    config,
    server,
    reasonToCode,
    codeToReason,
    connectTimeoutTime,
    logger,
  }: {
    config: WebSocketServerConfigInput;
    server?: https.Server;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    connectTimeoutTime?: number;
    logger?: Logger;
  }) {
    this.logger = logger ?? new Logger(this.constructor.name);
    this.config = {
      ...serverDefault,
      ...config,
    };

    this.connectTimeoutTime = connectTimeoutTime;

    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;
    const { p: closedP, resolveP: resolveClosedP } = utils.promise();
    this.closedP = closedP;
    this.resolveClosedP = resolveClosedP;

    if (server != null) {
      this.isServerShared = true;
      this.server = server;
    } else {
      this.isServerShared = false;
    }
  }

  @ready(new errors.ErrorWebSocketServerNotRunning())
  public get host(): Host {
    return (this.server.address() as any)?.address ?? ('' as Host);
  }

  @ready(new errors.ErrorWebSocketServerNotRunning())
  public get port(): Port {
    return (this.server.address() as any)?.port ?? (0 as Port);
  }

  /**
   * This just means the server is no longer accepting connections.
   * Like deregistered from a server.
   */
  public get closed() {
    return this._closed;
  }


  /**
   * Starts the WebSocketServer.
   *
   * If the server is shared and it is not listening, it will be started.
   * If the server is not shared, a server will be created and started.
   *
   * @param opts
   * @param opts.host - host to listen on, defaults to '::'
   * @param opts.port - port to listen on, defaults to 0
   * @param opts.path - the path the WebSocketServer should respond to upgrade requests on
   * @param opts.ipv6Only - ipv6 only, defaults to false
   */
  public async start({
    host = '::',
    port = 0,
    path,
    ipv6Only = false,
  }: {
    host?: string;
    port?: number;
    path?: string;
    ipv6Only?: boolean;
  } = {}): Promise<void> {
    this.logger.info(`Starting ${this.constructor.name}`);
    if (!this.isServerShared) {
      this.server = https.createServer({
        rejectUnauthorized:
          this.config.verifyPeer && this.config.verifyCallback == null,
        requestCert: true,
        key: this.config.key as any,
        cert: this.config.cert as any,
        ca: this.config.ca as any,
      });
    }

    this.webSocketServer = new ws.WebSocketServer({
      server: this.server,
      path,
      verifyClient: async (info, done) => {
        // Since this will only be done before the opening of a WebSocketConnection, there is no need to worry about the CA deviating from the WebSocketConnection's config.
        if (this.config.verifyPeer && this.config.verifyCallback != null) {
          const peerCert = (info.req.socket as TLSSocket).getPeerCertificate(
            true,
          );
          const peerCertChain = utils.toPeerCertChain(peerCert);
          const ca = utils.collectPEMs(this.config.ca).map(utils.pemToDER);
          try {
            await this.config.verifyCallback(peerCertChain, ca);
            return done(true);
          } catch (e) {
            return done(false, 525, 'TLS Handshake Failed');
          }
        }
        done(true);
      },
    });

    this.webSocketServer.on('connection', this.handleServerConnection);
    this.webSocketServer.on('close', this.handleWebSocketServerClosed);
    this.server.on('close', this.handleServerClosed);
    this.webSocketServer.on('error', this.handleServerError);
    this.server.on('error', this.handleServerError);
    this.server.on('request', this.handleServerRequest);

    if (!this.server.listening) {
      const listenProm = utils.promise<void>();
      this.server.listen(
        {
          host,
          port,
          ipv6Only,
        },
        listenProm.resolveP,
      );
      await listenProm.p;
    }

    this.addEventListener(
      events.EventWebSocketServerError.name,
      this.handleEventWebSocketServerError,
    );
    this.addEventListener(
      events.EventWebSocketServerClose.name,
      this.handleEventWebSocketServerClose,
      { once: true },
    );

    const address = this.server.address();
    if (address == null || typeof address === 'string') utils.never();
    this._port = address.port;
    this.logger.debug(`Listening on port ${this._port}`);
    this._host = address.address ?? '127.0.0.1';
    this.logger.info(`Started ${this.constructor.name}`);
  }

  public async stop({
    errorCode = utils.ConnectionErrorCode.Normal,
    errorMessage = '',
    force = true,
  }: {
    errorCode?: number;
    errorMessage?: string;
    force?: boolean;
  } = {}): Promise<void> {
    this.logger.info(`Stopping ${this.constructor.name}`);
    const destroyProms: Array<Promise<void>> = [];
    for (const webSocketConnection of this.connectionMap.values()) {
      destroyProms.push(
        webSocketConnection.stop({
          errorCode,
          reason: errorMessage,
          force,
        }),
      );
    }
    this.logger.debug('Awaiting connections to destroy');
    await Promise.all(destroyProms);
    this.logger.debug('All connections destroyed');
    // Close the server by closing the underlying WebSocketServer
    if (!this._closed) {
      // If this succeeds, then we are just transitioned to close
      // This will trigger noop recursion, that's fine
      this.dispatchEvent(new events.EventWebSocketServerClose());
    }
    await this.closedP;

    this.removeEventListener(
      events.EventWebSocketServerError.name,
      this.handleEventWebSocketServerError,
    );
    this.removeEventListener(
      events.EventWebSocketServerClose.name,
      this.handleEventWebSocketServerClose,
    );

    this.webSocketServer.off('connection', this.handleServerConnection);
    this.webSocketServer.off('close', this.handleServerClosed);
    this.server.off('close', this.handleServerClosed);
    this.webSocketServer.off('error', this.handleServerError);
    this.server.off('error', this.handleServerError);
    this.server.on('request', this.handleServerRequest);
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
  public updateConfig(config: WebSocketServerConfigInput): void {
    const tlsServer = this.server as tls.Server;
    const wsConfig = {
      ...this.config,
      ...config,
    };
    tlsServer.setSecureContext({
      key: wsConfig.key as any,
      cert: wsConfig.cert as any,
      ca: wsConfig.ca as any,
    });
    this.config = wsConfig;
  }

  /**
   * Will tell any normal HTTP request to upgrade
   */
  protected handleServerRequest = (_req, res: ServerResponse) => {
    res
      .writeHead(426, '426 Upgrade Required', {
        connection: 'Upgrade',
        upgrade: 'websocket',
      })
      .end('426 Upgrade Required');
  };
}

export default WebSocketServer;
