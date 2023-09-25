import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { startStop } from '@matrixai/async-init';
import * as events from '@/events';
import * as errors from '@/errors';
import WebSocketClient from '@/WebSocketClient';
import WebSocketServer from '@/WebSocketServer';
import * as utils from '@/utils';
import WebSocketConnection from '@/WebSocketConnection';
import * as testsUtils from './utils';

describe(WebSocketConnection.name, () => {
  const logger = new Logger(WebSocketConnection.name, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);

  const localhost = '127.0.0.1';

  describe('closing connection', () => {
    let tlsConfig: testsUtils.TLSConfigs;
    beforeEach(async () => {
      tlsConfig = await testsUtils.generateConfig('RSA');
    });
    test('handles a connection and closes before message', async () => {
      const server = new WebSocketServer({
        config: tlsConfig,
        logger,
      });
      await server.start({ host: localhost });

      const client = await WebSocketClient.createWebSocketClient({
        host: server.host,
        port: server.port,
        logger,
        config: {
          verifyPeer: false,
        },
      });

      const stream = await client.connection.newStream();

      const reader = stream.readable.getReader();

      await server.stop({ force: true });

      await expect(reader.read()).toReject();
    });

    test('connection dispatches correct close event', async () => {
      const connectionProm = utils.promise();

      const server = new WebSocketServer({
        config: tlsConfig,
        logger,
      });
      await server.start({ host: localhost });

      server.addEventListener(
        events.EventWebSocketServerConnection.name,
        () => {
          connectionProm.resolveP();
        },
      );

      const client = await WebSocketClient.createWebSocketClient({
        host: server.host,
        port: server.port,
        logger,
        config: {
          verifyPeer: false,
        },
      });

      const closeProm = utils.promise<events.EventWebSocketConnectionClose>();

      client.connection.addEventListener(
        events.EventWebSocketConnectionClose.name,
        closeProm.resolveP as any,
      );

      await client.destroy();

      const closeDetail = (await closeProm.p).detail;

      expect(closeDetail.data.errorCode).toBe(utils.ConnectionErrorCode.Normal);

      await server.stop();
    });
  });

  describe('keepalive', () => {
    let tlsConfig: testsUtils.TLSConfigs;
    beforeEach(async () => {
      tlsConfig = await testsUtils.generateConfig('RSA');
    });
    test('connection can time out on client', async () => {
      const connectionEventProm = utils.promise<WebSocketConnection>();
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfig.key,
          cert: tlsConfig.cert,
          verifyPeer: false,
          keepAliveIntervalTime: 1000,
          keepAliveTimeoutTime: Infinity,
        },
      });
      server.addEventListener(
        events.EventWebSocketServerConnection.name,
        (e: events.EventWebSocketServerConnection) =>
          connectionEventProm.resolveP(e.detail),
      );
      await server.start({
        host: localhost,
      });
      const client = await WebSocketClient.createWebSocketClient({
        host: '::ffff:127.0.0.1',
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          verifyPeer: false,
          keepAliveTimeoutTime: 100,
          keepAliveIntervalTime: Infinity,
        },
      });
      const clientConnection = client.connection;
      const clientTimeoutProm = utils.promise<void>();
      clientConnection.addEventListener(
        events.EventWebSocketConnectionError.name,
        (event: events.EventWebSocketConnectionError) => {
          if (
            event.detail instanceof
            errors.ErrorWebSocketConnectionKeepAliveTimeOut
          ) {
            clientTimeoutProm.resolveP();
          }
        },
      );
      await clientTimeoutProm.p;
      const serverConnection = await connectionEventProm.p;
      await testsUtils.sleep(100);
      // Server and client has cleaned up
      expect(clientConnection[startStop.running]).toBeFalse();
      expect(serverConnection[startStop.running]).toBeFalse();

      await client.destroy();
      await server.stop();
    });
    test('connection can time out on server', async () => {
      const connectionEventProm = utils.promise<WebSocketConnection>();
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfig.key,
          cert: tlsConfig.cert,
          verifyPeer: false,
          keepAliveTimeoutTime: 100,
          keepAliveIntervalTime: Infinity,
        },
      });
      server.addEventListener(
        events.EventWebSocketServerConnection.name,
        (e: events.EventWebSocketServerConnection) =>
          connectionEventProm.resolveP(e.detail),
      );
      await server.start({
        host: localhost,
      });
      const client = await WebSocketClient.createWebSocketClient({
        host: '::ffff:127.0.0.1',
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          verifyPeer: false,
          keepAliveIntervalTime: 1000,
          keepAliveTimeoutTime: Infinity,
        },
      });
      // Setting no keepalive should cause the connection to time out
      // It has cleaned up due to timeout
      const clientConnection = client.connection;
      const serverConnection = await connectionEventProm.p;
      const serverTimeoutProm = utils.promise<void>();
      serverConnection.addEventListener(
        events.EventWebSocketConnectionError.name,
        (evt: events.EventWebSocketConnectionError) => {
          if (
            evt.detail instanceof
            errors.ErrorWebSocketConnectionKeepAliveTimeOut
          ) {
            serverTimeoutProm.resolveP();
          }
        },
      );
      await serverTimeoutProm.p;
      await testsUtils.sleep(100);
      // Server and client has cleaned up
      expect(clientConnection[startStop.running]).toBeFalse();
      expect(serverConnection[startStop.running]).toBeFalse();

      await client.destroy();
      await server.stop();
    });
    test('keep alive prevents timeout on client', async () => {
      const connectionEventProm = utils.promise<WebSocketConnection>();
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfig.key,
          cert: tlsConfig.cert,
          verifyPeer: false,
          keepAliveTimeoutTime: 20000,
        },
      });
      server.addEventListener(
        events.EventWebSocketServerConnection.name,
        (e: events.EventWebSocketServerConnection) =>
          connectionEventProm.resolveP(e.detail),
      );
      await server.start({
        host: localhost,
      });
      const client = await WebSocketClient.createWebSocketClient({
        host: '::ffff:127.0.0.1',
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          verifyPeer: false,
          keepAliveTimeoutTime: 100,
          keepAliveIntervalTime: 50,
        },
      });
      const clientConnection = client.connection;
      const clientTimeoutProm = utils.promise<void>();
      clientConnection.addEventListener(
        events.EventWebSocketConnectionStream.name,
        (event: events.EventWebSocketConnectionError) => {
          if (
            event.detail instanceof
            errors.ErrorWebSocketConnectionKeepAliveTimeOut
          ) {
            clientTimeoutProm.resolveP();
          }
        },
      );
      await connectionEventProm.p;
      // Connection would time out after 100ms if keep alive didn't work
      await Promise.race([
        testsUtils.sleep(300),
        clientTimeoutProm.p.then(() => {
          throw Error('Connection timed out');
        }),
      ]);
      await client.destroy();
      await server.stop();
    });
    test('keep alive prevents timeout on server', async () => {
      const connectionEventProm = utils.promise<WebSocketConnection>();
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfig.key,
          cert: tlsConfig.cert,
          verifyPeer: false,
          keepAliveTimeoutTime: 100,
          keepAliveIntervalTime: 50,
        },
      });
      server.addEventListener(
        events.EventWebSocketServerConnection.name,
        (e: events.EventWebSocketServerConnection) =>
          connectionEventProm.resolveP(e.detail),
      );
      await server.start({
        host: localhost,
      });
      const client = await WebSocketClient.createWebSocketClient({
        host: '::ffff:127.0.0.1',
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          verifyPeer: false,
          keepAliveTimeoutTime: 20000,
        },
      });
      // Setting no keepalive should cause the connection to time out
      // It has cleaned up due to timeout
      const serverConnection = await connectionEventProm.p;
      const serverTimeoutProm = utils.promise<void>();
      serverConnection.addEventListener(
        events.EventWebSocketConnectionStream.name,
        (event: events.EventWebSocketConnectionError) => {
          if (
            event.detail instanceof
            errors.ErrorWebSocketConnectionKeepAliveTimeOut
          ) {
            serverTimeoutProm.resolveP();
          }
        },
      );
      // Connection would time out after 100ms if keep alive didn't work
      await Promise.race([
        testsUtils.sleep(300),
        serverTimeoutProm.p.then(() => {
          throw Error('Connection timed out');
        }),
      ]);
      await client.destroy();
      await server.stop();
    });
    test('client keep alive prevents timeout on server', async () => {
      const connectionEventProm = utils.promise<WebSocketConnection>();
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfig.key,
          cert: tlsConfig.cert,
          verifyPeer: false,
          keepAliveTimeoutTime: 100,
        },
      });
      server.addEventListener(
        events.EventWebSocketServerConnection.name,
        (e: events.EventWebSocketServerConnection) =>
          connectionEventProm.resolveP(e.detail),
      );
      await server.start({
        host: localhost,
      });
      const client = await WebSocketClient.createWebSocketClient({
        host: '::ffff:127.0.0.1',
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          verifyPeer: false,
          keepAliveTimeoutTime: 20000,
          keepAliveIntervalTime: 50,
        },
      });
      // Setting no keepalive should cause the connection to time out
      // It has cleaned up due to timeout
      const serverConnection = await connectionEventProm.p;
      const serverTimeoutProm = utils.promise<void>();
      serverConnection.addEventListener(
        events.EventWebSocketConnectionStream.name,
        (event: events.EventWebSocketConnectionError) => {
          if (
            event.detail instanceof
            errors.ErrorWebSocketConnectionKeepAliveTimeOut
          ) {
            serverTimeoutProm.resolveP();
          }
        },
      );
      // Connection would time out after 100ms if keep alive didn't work
      await Promise.race([
        testsUtils.sleep(300),
        serverTimeoutProm.p.then(() => {
          throw Error('Connection timed out');
        }),
      ]);
      await client.destroy();
      await server.stop();
    });
  });
});
