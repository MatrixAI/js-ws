import type {
  Host,
  Hostname,
  ResolveHostname,
  StreamCodeToReason,
  StreamReasonToCode,
  WebSocketClientConfigInput,
  WebSocketClientConfigInputWithoutTLS,
} from './types.js';
import type { ContextTimed, ContextTimedInput } from '@matrixai/contexts';
import { AbstractEvent } from '@matrixai/events';
import { createDestroy } from '@matrixai/async-init';
import { EventAll } from '@matrixai/events';
import { default as contexts } from '@matrixai/contexts';
import { WebSocket as WSWebSocket } from 'ws';
import Logger from '@matrixai/logger';
import * as errors from './errors.js';
import WebSocketConnection from './WebSocketConnection.js';
import WebSocketConnectionMap from './WebSocketConnectionMap.js';
import { clientDefault, connectTimeoutTime } from './config.js';
import * as events from './events.js';
import * as utils from './utils.js';

interface WebSocketClient extends createDestroy.CreateDestroy {}
/**
 * You must provide an error handler `addEventListener('error')`.
 * Otherwise, errors will just be ignored.
 *
 * Events:
 * - {@link events.EventWebSocketClientDestroy}
 * - {@link events.EventWebSocketClientDestroyed}
 * - {@link events.EventWebSocketClientError} - includes re-dispatched {@link events.EventWebSocketConnectionError}
 * - {@link events.EventWebSocketClientClose}
 * - {@link events.EventWebSocketConnection} - all dispatched events from {@link WebSocketConnection}
 */
@createDestroy.CreateDestroy({
  eventDestroy: events.EventWebSocketClientDestroy,
  eventDestroyed: events.EventWebSocketClientDestroyed,
})
class WebSocketClient {
  /**
   * Creates a WebSocketClient
   *
   * @param obj
   * @param obj.host - target host address to connect to
   * @param obj.port - target port to connect to
   * @param obj.config - optional config
   * @param obj.logger - optional logger
   *
   * @throws {errors.ErrorWebSocketHostInvalid}
   * @throws {errors.ErrorWebSocketPortInvalid}
   * @throws {errors.ErrorWebSocketConnection} - re-dispatched from {@link WebSocketConnection}
   */
  public static async createWebSocketClient(
    {
      host,
      port,
      path = '',
      protocol = 'wss',
      config,
      logger = new Logger(`${this.name}`),
    }: (
      | {
          protocol?: 'wss';
          config?: WebSocketClientConfigInput;
        }
      | {
          protocol: 'ws';
          config?: WebSocketClientConfigInputWithoutTLS;
        }
    ) & {
      host: string;
      port: number;
      path?: string;
      resolveHostname?: ResolveHostname;
      reasonToCode?: StreamReasonToCode;
      codeToReason?: StreamCodeToReason;
      logger?: Logger;
      _webSocketClass?: typeof globalThis.WebSocket | typeof WSWebSocket;
    },
    ctx?: Partial<ContextTimedInput>,
  ): Promise<WebSocketClient>;
  @contexts.decorators.timedCancellable(
    true,
    connectTimeoutTime,
    errors.ErrorWebSocketClientCreateTimeOut,
  )
  public static async createWebSocketClient(
    {
      host,
      port,
      protocol = 'wss',
      path = '',
      config,
      resolveHostname = utils.resolveHostname,
      reasonToCode,
      codeToReason,
      logger = new Logger(`${this.name}`),
      _webSocketClass = globalThis.WebSocket == null
        ? WSWebSocket
        : globalThis.WebSocket,
    }: (
      | {
          protocol?: 'wss';
          config?: WebSocketClientConfigInput;
        }
      | {
          protocol: 'ws';
          config?: WebSocketClientConfigInputWithoutTLS;
        }
    ) & {
      host: string;
      port: number;
      path?: string;
      resolveHostname?: ResolveHostname;
      reasonToCode?: StreamReasonToCode;
      codeToReason?: StreamCodeToReason;
      logger?: Logger;
      _webSocketClass?: typeof globalThis.WebSocket | typeof WSWebSocket;
    },
    @contexts.decorators.context ctx: ContextTimed,
  ): Promise<WebSocketClient> {
    logger.info(`Create ${this.name} to ${host}:${port}`);
    const wsConfig = {
      ...clientDefault,
      ...config,
    };

    let hostOrHostname_ = host as Host | Hostname;
    // We only resolve the host when working in Node,
    // As `browser.dns.resolve` API is still canary-only on Chrome
    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/dns/resolve
    if (_webSocketClass === WSWebSocket) {
      const [host_] = await utils.resolveHost(host, resolveHostname);
      // If the target host is in fact a zero IP, it cannot be used
      // as a target host, so we need to resolve it to a non-zero IP
      // in this case, 0.0.0.0 is resolved to 127.0.0.1 and :: and ::0 is
      // resolved to ::1
      hostOrHostname_ = utils.resolvesZeroIP(host_);
    }
    const port_ = utils.toPort(port);

    let path_ = path;
    if (path !== '' && path[0] !== '/') {
      path_ = `/${path_}`;
    }

    const address = `${protocol}://${utils.buildAddress(
      hostOrHostname_,
      port_,
    )}${path_}`;

    let webSocket: WSWebSocket | typeof globalThis.WebSocket.prototype;
    if (_webSocketClass === WSWebSocket) {
      webSocket = new WSWebSocket(address, {
        rejectUnauthorized:
          wsConfig.verifyPeer && wsConfig.verifyCallback == null,
        key: wsConfig.key as any,
        cert: wsConfig.cert as any,
        ca: wsConfig.ca as any,
        headers: wsConfig.headers,
      });
    } else {
      webSocket = new _webSocketClass(address);
    }

    const connectionId = 0;
    const connection = new WebSocketConnection({
      type: 'client',
      connectionId,
      config: wsConfig,
      socket: webSocket,
      reasonToCode,
      codeToReason,
      logger: logger.getChild(`${WebSocketConnection.name} ${connectionId}`),
    });
    const client = new this({
      address,
      logger,
      connection,
    });
    // Setting up connection events
    connection.addEventListener(
      events.EventWebSocketConnectionStopped.name,
      client.handleEventWebSocketConnectionStopped,
      { once: true },
    );
    connection.addEventListener(
      EventAll.name,
      client.handleEventWebSocketConnection,
    );
    connection.addEventListener(
      events.EventWebSocketConnectionError.name,
      client.handleEventWebSocketConnectionError,
    );
    // Setting up client events
    client.addEventListener(
      events.EventWebSocketClientError.name,
      client.handleEventWebSocketClientError,
    );
    client.addEventListener(
      events.EventWebSocketClientClose.name,
      client.handleEventWebSocketClientClose,
      { once: true },
    );

    client.connectionMap.add(connection);

    try {
      await connection.start(ctx);
    } catch (e) {
      client.connectionMap.delete(connectionId);
      connection.removeEventListener(
        events.EventWebSocketConnectionStopped.name,
        client.handleEventWebSocketConnectionStopped,
      );
      connection.removeEventListener(
        EventAll.name,
        client.handleEventWebSocketConnection,
      );

      client.removeEventListener(
        events.EventWebSocketClientError.name,
        client.handleEventWebSocketClientError,
      );
      client.removeEventListener(
        events.EventWebSocketClientClose.name,
        client.handleEventWebSocketClientClose,
      );
      throw e;
    }

    logger.info(`Created ${this.name} to ${address}`);
    return client;
  }

  /**
   * The connection of the client.
   */
  public readonly connection: WebSocketConnection;

  /**
   * Resolved when the underlying server is closed.
   */
  public readonly closedP: Promise<void>;

  protected logger: Logger;

  /**
   * Map of connections with connectionId keys that correspond to WebSocketConnection values.
   */
  public readonly connectionMap: WebSocketConnectionMap =
    new WebSocketConnectionMap();
  protected address: string;
  protected _closed: boolean = false;
  protected resolveClosedP: () => void;

  protected handleEventWebSocketClientError = async (
    evt: events.EventWebSocketClientError,
  ) => {
    const error = evt.detail;
    if (
      (error instanceof errors.ErrorWebSocketConnectionLocal ||
        error instanceof errors.ErrorWebSocketConnectionPeer) &&
      error.data?.errorCode === utils.ConnectionErrorCode.Normal
    ) {
      this.logger.info(utils.formatError(error));
    } else {
      this.logger.error(utils.formatError(error));
    }
    // If the error is an internal error, throw it to become `EventError`
    // By default this will become an uncaught exception
    // Cannot attempt to close the connection, because an internal error is unrecoverable
    if (error instanceof errors.ErrorWebSocketConnectionInternal) {
      // Use `EventError` to deal with this
      throw error;
    }
  };

  protected handleEventWebSocketClientClose = async () => {
    await this.connection.stop({ force: true });
    this._closed = true;
    this.resolveClosedP();
    if (!this[createDestroy.destroyed]) {
      // Failing this is a software error
      await this.destroy({ force: true });
    }
  };

  protected handleEventWebSocketConnectionStopped = async (
    evt: events.EventWebSocketConnectionStopped,
  ) => {
    const connection = evt.target as WebSocketConnection;
    connection.removeEventListener(
      EventAll.name,
      this.handleEventWebSocketConnection,
    );
    connection.addEventListener(
      events.EventWebSocketConnectionError.name,
      this.handleEventWebSocketConnectionError,
    );
    this.connectionMap.delete(connection.connectionId);
    this.dispatchEvent(new events.EventWebSocketClientClose());
  };

  protected handleEventWebSocketConnection = (evt: EventAll) => {
    if (evt.detail instanceof AbstractEvent) {
      this.dispatchEvent(evt.detail.clone());
    }
  };

  /**
   * All connection errors are redispatched as client errors.
   * Connection errors encompass both graceful closes and non-graceful closes.
   * This also includes `ErrorWebSocketConnectionInternal`
   */
  protected handleEventWebSocketConnectionError = (
    evt: events.EventWebSocketConnectionError,
  ) => {
    const error = evt.detail;
    this.dispatchEvent(new events.EventWebSocketClientError({ detail: error }));
  };

  /**
   * Boolean that indicates whether the internal server is closed or not.
   */
  public get closed() {
    return this._closed;
  }

  /**
   * Constructor
   * @param opts
   * @param opts.address - the address to connect to
   * @param opts.logger - injected logger
   * @param opts.connection - injected connection
   * @internal
   */
  public constructor({
    address,
    logger,
    connection,
  }: {
    address: string;
    logger: Logger;
    connection: WebSocketConnection;
  }) {
    this.address = address;
    this.logger = logger;
    this.connection = connection;
    const { p: closedP, resolveP: resolveClosedP } = utils.promise();
    this.closedP = closedP;
    this.resolveClosedP = resolveClosedP;
  }

  /**
   * Destroys WebSocketClient
   * @param opts
   * @param opts.errorCode - The error code to send to connections on closing
   * @param opts.errorMessage - The error message to send to connections on closing
   * @param opts.force - When force is false, the returned promise will wait for all streams and connections to close naturally before resolving.
   */
  public async destroy({
    errorCode = utils.ConnectionErrorCode.Normal,
    errorMessage = '',
    force = true,
  }: {
    errorCode?: number;
    errorMessage?: string;
    force?: boolean;
  } = {}) {
    this.logger.info(`Destroy ${this.constructor.name} on ${this.address}`);
    if (!this._closed) {
      // Failing this is a software error
      await this.connection.stop({
        errorCode,
        reason: errorMessage,
        force,
      });
      this.dispatchEvent(new events.EventWebSocketClientClose());
    }
    await this.closedP;
    this.removeEventListener(
      events.EventWebSocketClientError.name,
      this.handleEventWebSocketClientError,
    );
    this.removeEventListener(
      events.EventWebSocketClientClose.name,
      this.handleEventWebSocketClientClose,
    );
  }
}

export default WebSocketClient;
