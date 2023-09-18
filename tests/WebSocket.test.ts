import { X509Certificate } from '@peculiar/x509';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { status } from '@matrixai/async-init';
import * as events from '@/events';
import WebSocketClient from '@/WebSocketClient';
import WebSocketServer from '@/WebSocketServer';
import * as utils from '@/utils';
import * as errors from '@/errors';
import * as testsUtils from './utils';

// Process.on('unhandledRejection', (reason) => {
//   console.log(reason); // log the reason including the stack trace
//   throw reason;
// });

describe(WebSocketClient.name, () => {
  const logger = new Logger('websocket test', LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  let tlsConfigServer: testsUtils.TLSConfigs;

  const ipv4Host = '127.0.0.1';
  const ipv6Host = '::1';

  beforeAll(async () => {
    tlsConfigServer = await testsUtils.generateConfig('RSA');
  });

  test('makes a connection', async () => {
    const connectionProm = utils.promise();

    const server = new WebSocketServer({
      config: tlsConfigServer,
      logger,
    });
    await server.start({ host: ipv4Host });

    server.addEventListener(events.EventWebSocketServerConnection.name, () => {
      connectionProm.resolveP();
    });

    await WebSocketClient.createWebSocketClient({
      host: server.getHost(),
      port: server.getPort(),
      logger,
      config: {
        verifyPeer: false
      }
    });

    await expect(connectionProm.p).toResolve();

    await server.stop();
  });

  test('client can verify TLS', async () => {
    const connectionProm = utils.promise();

    const x509Cert = new X509Certificate(tlsConfigServer.cert);

    const server = new WebSocketServer({
      config: {
        ...tlsConfigServer,
        verifyPeer: false,
      },
      logger,
    });
    await server.start({ host: ipv4Host });

    server.addEventListener(events.EventWebSocketServerConnection.name, () => {
      connectionProm.resolveP();
    });

    let peerCertRaw: Buffer;

    await WebSocketClient.createWebSocketClient({
      host: server.getHost(),
      port: server.getPort(),
      logger,
      config: {
        verifyPeer: true,
        verifyCallback: async (peerCert) => {
          peerCertRaw = peerCert.raw;
        }
      }
    });

    await expect(connectionProm.p).toResolve();
    expect(peerCertRaw!.buffer).toEqual(x509Cert.rawData);

    await server.stop();
  });

  test('server can verify TLS', async () => {
    const connectionProm = utils.promise();

    const tlsConfigClient = await testsUtils.generateConfig('RSA');

    const x509Cert = new X509Certificate(tlsConfigClient.cert);

    let peerCertRaw: Buffer;

    const server = new WebSocketServer({
      config: {
        ...tlsConfigServer,
        verifyPeer: true,
        verifyCallback: async (peerCert) => {
          peerCertRaw = peerCert.raw;
        }
      },
      logger,
    });
    await server.start({ host: ipv4Host });

    server.addEventListener(events.EventWebSocketServerConnection.name, () => {
      connectionProm.resolveP();
    });

    await WebSocketClient.createWebSocketClient({
      host: server.getHost(),
      port: server.getPort(),
      logger,
      config: {
        ...tlsConfigClient,
        verifyPeer: false,
      }
    });

    await expect(connectionProm.p).toResolve();
    expect(peerCertRaw!.buffer).toEqual(x509Cert.rawData);

    await server.stop();
  });

  test('can change TLS config', async () => {
    const connectionProm = utils.promise();
    const newTlsConfigServer = await testsUtils.generateConfig('RSA');

    const x509Cert = new X509Certificate(newTlsConfigServer.cert);

    const server = new WebSocketServer({
      config: {
        ...tlsConfigServer,
        verifyPeer: false,
      },
      logger,
    });
    await server.start({ host: ipv4Host });

    server.updateConfig(newTlsConfigServer);

    server.addEventListener(events.EventWebSocketServerConnection.name, () => {
      connectionProm.resolveP();
    });

    let peerCertRaw: Buffer;

    await WebSocketClient.createWebSocketClient({
      host: server.getHost(),
      port: server.getPort(),
      logger,
      config: {
        verifyPeer: true,
        verifyCallback: async (peerCert) => {
          peerCertRaw = peerCert.raw;
        }
      }
    });

    await expect(connectionProm.p).toResolve();
    expect(peerCertRaw!.buffer).toEqual(x509Cert.rawData);

    await server.stop();
  });

  test('makes a connection over IPv6', async () => {
    const connectionProm = utils.promise();

    const server = new WebSocketServer({
      config: tlsConfigServer,
      logger,
    });
    await server.start({ host: ipv6Host });

    server.addEventListener(events.EventWebSocketServerConnection.name, () => {
      connectionProm.resolveP();
    });

    await WebSocketClient.createWebSocketClient({
      host: server.getHost(),
      port: server.getPort(),
      logger,
      config: {
        verifyPeer: false
      }
    });

    await expect(connectionProm.p).toResolve();

    await server.stop();
  });
  test('handles a connection and closes before message', async () => {
    const server = new WebSocketServer({
      config: tlsConfigServer,
      logger,
    });
    await server.start({ host: ipv4Host });

    const client = await WebSocketClient.createWebSocketClient({
      host: server.getHost(),
      port: server.getPort(),
      logger,
      config: {
        verifyPeer: false
      }
    });

    const stream = await client.connection.streamNew('bidi');

    const reader = stream.readable.getReader();

    await server.stop({ force: true });

    await expect(reader.read()).toReject();
  });
  test('handles multiple connections', async () => {
    const conns = 10;
    let serverConns = 0;

    const server = new WebSocketServer({
      config: tlsConfigServer,
      logger,
    });
    await server.start({ host: ipv4Host });

    server.addEventListener(events.EventWebSocketServerConnection.name, () => {
      serverConns++;
    });

    const clients: Array<WebSocketClient> = [];
    for (let i = 0; i < conns; i++) {
      const client = await WebSocketClient.createWebSocketClient({
        host: server.getHost(),
        port: server.getPort(),
        logger,
        config: {
          verifyPeer: false
        }
      });

      await client.connection.streamNew('bidi');

      clients.push(client);
    }
    expect(serverConns).toBe(conns);
    await server.stop({ force: true });
  });
  test('handles https server failure', async () => {
    const server = new WebSocketServer({
      config: tlsConfigServer,
      logger,
    });
    await server.start({ host: ipv4Host });

    const closeP = utils.promise<void>();
    // @ts-ignore: protected property
    server.server.close(() => {
      closeP.resolveP();
    });
    await closeP.p;

    // The webSocketServer should stop itself
    expect(server[status]).toBe(null);
  });
  test('handles WebSocket server failure', async () => {
    const server = new WebSocketServer({
      config: tlsConfigServer,
      logger,
    });
    await server.start({ host: ipv4Host });

    const closeP = utils.promise<void>();
    // @ts-ignore: protected property
    server.webSocketServer.close(() => {
      closeP.resolveP();
    });
    await closeP.p;

    // The webSocketServer should stop itself
    expect(server[status]).toBe(null);
  });
  test('connection dispatches correct close event', async () => {
    const connectionProm = utils.promise();

    const server = new WebSocketServer({
      config: tlsConfigServer,
      logger,
    });
    await server.start({ host: ipv4Host });

    server.addEventListener(events.EventWebSocketServerConnection.name, () => {
      connectionProm.resolveP();
    });

    const client = await WebSocketClient.createWebSocketClient({
      host: server.getHost(),
      port: server.getPort(),
      logger,
      config: {
        verifyPeer: false
      }
    });

    const closeProm = utils.promise<any>();

    client.connection.addEventListener(
      events.EventWebSocketConnectionClose.name,
      closeProm.resolveP,
    );

    await client.destroy();

    const closeDetail = (await closeProm.p).detail;

    expect(closeDetail.type).toEqual('local');
    expect(closeDetail.errorCode).toBe(utils.ConnectionErrorCode.Normal);

    await server.stop();
  });
});
