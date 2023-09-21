import type {
  Host,
  Port,
  VerifyCallback,
  WebSocketClientConfigInput,
  WebSocketConfig,
} from './types';
import { AbstractEvent } from '@matrixai/events';
import { createDestroy } from '@matrixai/async-init';
import Logger from '@matrixai/logger';
import WebSocket from 'ws';
import { Validator } from 'ip-num';
import { EventAll, EventDefault } from '@matrixai/events';
import * as errors from './errors';
import WebSocketConnection from './WebSocketConnection';
import WebSocketConnectionMap from './WebSocketConnectionMap';
import { clientDefault } from './config';
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
 * - {@link events.EventWebSocketClientError}
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
@createDestroy.CreateDestroy({
  eventDestroy: events.EventWebSocketClientDestroy,
  eventDestroyed: events.EventWebSocketClientDestroyed,
})
class WebSocketClient extends EventTarget {
  /**
   * @param obj
   * @param obj.host - Target host address to connect to
   * @param obj.port - Target port to connect to
   * @param obj.expectedNodeIds - Expected NodeIds you are trying to connect to. Will validate the cert chain of the
   * sever. If none of these NodeIDs are found the connection will be rejected.
   * @param obj.connectionTimeoutTime - Timeout time used when attempting the connection.
   * Default is Infinity milliseconds.
   * @param obj.pingIntervalTime - Time between pings for checking connection health and keep alive.
   * Default is 1,000 milliseconds.
   * @param obj.pingTimeoutTimeTime - Time before connection is cleaned up after no ping responses.
   * Default is 10,000 milliseconds.
   * @param obj.logger
   */
  static async createWebSocketClient({
    host,
    port,
    config,
    logger = new Logger(`${this.name}`),
  }: {
    host: string;
    port: number;
    config?: WebSocketClientConfigInput;
    logger?: Logger;
  }): Promise<WebSocketClient> {
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

    // RejectUnauthorized must be false when verifyCallback exists
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
      await connection.start({
        timer: wsConfig.connectTimeoutTime,
      });
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

  public readonly connection: WebSocketConnection;
  public readonly closedP: Promise<void>;

  protected logger: Logger;

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
    this.connectionMap.delete(connection.connectionId);
    this.dispatchEvent(new events.EventWebSocketClientClose());
  };

  protected handleEventWebSocketConnection = (evt: EventAll) => {
    if (evt.detail instanceof AbstractEvent) {
      this.dispatchEvent(evt.detail.clone());
    }
  };

  public get closed() {
    return this._closed;
  }

  constructor({
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
