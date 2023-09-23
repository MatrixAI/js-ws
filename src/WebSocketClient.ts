import type { Port, WebSocketClientConfigInput } from './types';
import type { ContextTimed, ContextTimedInput } from '@matrixai/contexts';
import { AbstractEvent } from '@matrixai/events';
import { createDestroy } from '@matrixai/async-init';
import Logger from '@matrixai/logger';
import WebSocket from 'ws';
import { Validator } from 'ip-num';
import { EventAll } from '@matrixai/events';
import { context, timedCancellable } from '@matrixai/contexts/dist/decorators';
import * as errors from './errors';
import WebSocketConnection from './WebSocketConnection';
import WebSocketConnectionMap from './WebSocketConnectionMap';
import { clientDefault, connectTimeoutTime } from './config';
import * as events from './events';
import * as utils from './utils';

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
class WebSocketClient extends EventTarget {
  /**
   * Creates a WebSocketClient
   *
   * @param obj
   * @param obj.host - target host address to connect to
   * @param obj.port - target port to connect to
   * @param obj.config - optional config
   * @param obj.logger - optional logger
   *
   * @throws {errors.ErrorWebSocketClientInvalidHost}
   * @throws {errors.ErrorWebSocketConnection} - re-dispatched from {@link WebSocketConnection}
   */
  public static async createWebSocketClient(
    {
      host,
      port,
      config,
      logger = new Logger(`${this.name}`),
    }: {
      host: string;
      port: number;
      config?: WebSocketClientConfigInput;
      logger?: Logger;
    },
    ctx?: Partial<ContextTimedInput>,
  ): Promise<WebSocketClient>;
  @timedCancellable(
    true,
    connectTimeoutTime,
    errors.ErrorWebSocketClientCreateTimeOut,
  )
  public static async createWebSocketClient(
    {
      host,
      port,
      config,
      logger = new Logger(`${this.name}`),
    }: {
      host: string;
      port: number;
      config?: WebSocketClientConfigInput;
      logger?: Logger;
    },
    @context ctx: ContextTimed,
  ): Promise<WebSocketClient> {
    logger.info(`Create ${this.name} to ${host}:${port}`);
    const wsConfig = {
      ...clientDefault,
      ...config,
    };

    let host_: string;
    if (Validator.isValidIPv4String(host)[0]) {
      host_ = host;
    } else if (Validator.isValidIPv6String(host)[0]) {
      host_ = `[${host}]`;
    } else {
      throw new errors.ErrorWebSocketClientInvalidHost();
    }
    let port_: Port;
    if (port >= 0 && port <= 65535) {
      port_ = port as Port;
    } else {
      throw new errors.ErrorWebSocketClientInvalidHost();
    }

    const address = `wss://${host_}:${port_}`;

    // RejectUnauthorized must be false when TLSVerifyCallback exists,
    // This is so that verification can be deferred to the callback rather than the system installed Certs
    const webSocket = new WebSocket(address, {
      rejectUnauthorized:
        wsConfig.verifyPeer && wsConfig.verifyCallback == null,
      key: wsConfig.key as any,
      cert: wsConfig.cert as any,
      ca: wsConfig.ca as any,
    });

    const connectionId = 0;
    const connection = new WebSocketConnection({
      type: 'client',
      connectionId,
      config: wsConfig,
      socket: webSocket,
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
    this.logger.error(utils.formatError(error));
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
    super();
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
