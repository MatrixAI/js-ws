import { promise } from "@/utils";
import * as events from '@/events';
import * as errors from '@/errors';
import * as testsUtils from './utils';
import WebSocketClient from "@/WebSocketClient";
import Logger, { formatting, LogLevel, StreamHandler } from "@matrixai/logger";
import { X509Certificate } from "@peculiar/x509";
import WebSocketServer from "@/WebSocketServer";
import { KeyTypes } from "./utils";
import { DetailedPeerCertificate } from "tls";

describe(WebSocketClient.name, () => {
  const logger = new Logger(`${WebSocketClient.name} Test`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const localhost = '127.0.0.1';
  const types: Array<KeyTypes> = ['RSA', 'ECDSA', 'ED25519'];
  // const types: Array<KeyTypes> = ['RSA'];
  const defaultType = types[0];
  test('to ipv6 server succeeds', async () => {
    const connectionEventProm = promise<events.EventWebSocketServerConnection>();
    const tlsConfigServer = await testsUtils.generateConfig(defaultType);
    const server = new WebSocketServer({
      logger: logger.getChild(WebSocketServer.name),
      config: {
        key: tlsConfigServer.key,
        cert: tlsConfigServer.cert,
        verifyPeer: false,
      },
    });
    server.addEventListener(
      events.EventWebSocketServerConnection.name,
      (e: events.EventWebSocketServerConnection) =>
        connectionEventProm.resolveP(e),
    );
    await server.start({
      host: '::1',
      port: 0,
    });
    const client = await WebSocketClient.createWebSocketClient({
      host: '::1',
      port: server.port,
      logger: logger.getChild(WebSocketClient.name),
      config: {
        verifyPeer: false,
      },
    });
    const conn = (await connectionEventProm.p).detail;
    expect(conn.localHost).toBe('::1');
    expect(conn.localPort).toBe(server.port);
    expect(conn.remoteHost).toBe('::1');
    expect(conn.remotePort).toBe(client.connection.localPort);
    await client.destroy();
    await server.stop();
  });
  test('to dual stack server succeeds', async () => {
    const connectionEventProm = promise<events.EventWebSocketServerConnection>();
    const tlsConfigServer = await testsUtils.generateConfig(defaultType);
    const server = new WebSocketServer({
      logger: logger.getChild(WebSocketServer.name),
      config: {
        key: tlsConfigServer.key,
        cert: tlsConfigServer.cert,
        verifyPeer: false,
      },
    });
    server.addEventListener(
      events.EventWebSocketServerConnection.name,
      (e: events.EventWebSocketServerConnection) =>
        connectionEventProm.resolveP(e),
    );
    await server.start({
      host: '::',
      port: 0,
    });
    const client = await WebSocketClient.createWebSocketClient({
      host: '::', // Will resolve to ::1
      port: server.port,
      logger: logger.getChild(WebSocketClient.name),
      config: {
        verifyPeer: false,
      },
    });
    const conn = (await connectionEventProm.p).detail;
    expect(conn.localHost).toBe('::1');
    expect(conn.localPort).toBe(server.port);
    expect(conn.remoteHost).toBe('::1');
    expect(conn.remotePort).toBe(client.connection.localPort);
    await client.destroy();
    await server.stop();
  });
  describe('hard connection failures', () => {
    test('internal error when there is no server', async () => {
      // WebSocketClient repeatedly dials until the connection timeout
      await expect(
        WebSocketClient.createWebSocketClient({
          host: localhost,
          port: 56666,
          logger: logger.getChild(WebSocketClient.name),
          config: {
            keepAliveTimeoutTime: 200,
            verifyPeer: false,
          },
        }),
      ).rejects.toHaveProperty(["cause", "name"], errors.ErrorWebSocketConnectionInternal.name);
    });
    test('client times out with ctx timer while starting', async () => {
      const tlsConfigServer = await testsUtils.generateConfig(defaultType);
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfigServer.key,
          cert: tlsConfigServer.cert,
          verifyPeer: true,
          verifyCallback: async () => {
            await testsUtils.sleep(1000);
          }
        },
      });
      await server.start({
        host: localhost,
        port: 0,
      });
      await expect(
        WebSocketClient.createWebSocketClient(
          {
            host: localhost,
            port: server.port,
            logger: logger.getChild(WebSocketClient.name),
            config: {
              verifyPeer: false,
            },
          },
          { timer: 100 },
        ),
      ).rejects.toThrow(errors.ErrorWebSocketClientCreateTimeOut);
      await server.stop();
    });
    test('client times out with ctx signal while starting', async () => {
      const abortController = new AbortController();
      const tlsConfigServer = await testsUtils.generateConfig(defaultType);
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfigServer.key,
          cert: tlsConfigServer.cert,
          verifyPeer: true,
          verifyCallback: async () => {
            await testsUtils.sleep(1000);
          }
        },
      });
      await server.start({
        host: localhost,
        port: 0,
      });
      const clientProm = WebSocketClient.createWebSocketClient(
        {
          host: localhost,
          port: server.port,
          logger: logger.getChild(WebSocketClient.name),
          config: {
            verifyPeer: false,
          },
        },
        { signal: abortController.signal },
      );
      await testsUtils.sleep(100);
      abortController.abort(Error('abort error'));
      await expect(clientProm).rejects.toThrow(Error('abort error'));
      await server.stop();
    });
  });
  describe.each(types)('TLS rotation with %s', (type) => {
    test('existing connections config is unchanged and still function', async () => {
      const tlsConfig1 = await testsUtils.generateConfig(type);
      const tlsConfig2 = await testsUtils.generateConfig(type);
      const tlsCert1 = new X509Certificate(tlsConfig1.cert);
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfig1.key,
          cert: tlsConfig1.cert,
        },
      });
      await server.start({
        host: localhost,
      });
      let peerCertProm = promise<DetailedPeerCertificate>();
      const client1 = await WebSocketClient.createWebSocketClient({
        host: localhost,
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          verifyPeer: true,
          verifyCallback: async (peerCert) => {
            peerCertProm.resolveP(peerCert);
          },
        },
      });
      server.updateConfig({
        key: tlsConfig2.key,
        cert: tlsConfig2.cert,
      });

      const peerCert = await peerCertProm.p;

      expect(peerCert.raw.buffer).toEqual(tlsCert1.rawData);

      await client1.destroy();
      await server.stop();
    });
    test('new connections use new config', async () => {
      const tlsConfig1 = await testsUtils.generateConfig(type);
      const tlsConfig2 = await testsUtils.generateConfig(type);
      const tlsCert2 = new X509Certificate(tlsConfig2.cert);
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfig1.key,
          cert: tlsConfig1.cert,
        },
      });
      await server.start({
        host: localhost,
      });
      const client1 = await WebSocketClient.createWebSocketClient({
        host: localhost,
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          verifyPeer: true,
          verifyCallback: async () => {},
        },
      });
      server.updateConfig({
        key: tlsConfig2.key,
        cert: tlsConfig2.cert,
      });
      // Starting a new connection has a different peerCertChain
      let peerCertProm = promise<DetailedPeerCertificate>();
      const client2 = await WebSocketClient.createWebSocketClient({
        host: localhost,
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          verifyPeer: true,
          verifyCallback: async (peerCert) => {
            peerCertProm.resolveP(peerCert);
          },
        },
      });
      expect((await peerCertProm.p).raw.buffer).toEqual(tlsCert2.rawData);
      await client1.destroy();
      await client2.destroy();
      await server.stop();
    });
  });
});
