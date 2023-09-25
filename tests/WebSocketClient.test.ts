import type { KeyTypes } from './utils';
import type WebSocketConnection from '@/WebSocketConnection';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { promise, pemToDER } from '@/utils';
import * as events from '@/events';
import * as errors from '@/errors';
import WebSocketClient from '@/WebSocketClient';
import WebSocketServer from '@/WebSocketServer';
import * as testsUtils from './utils';

describe(WebSocketClient.name, () => {
  const logger = new Logger(`${WebSocketClient.name} Test`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const localhost = '127.0.0.1';
  const types: Array<KeyTypes> = ['RSA', 'ECDSA', 'ED25519'];
  // Const types: Array<KeyTypes> = ['RSA'];
  const defaultType = types[0];
  test('to ipv6 server succeeds', async () => {
    const connectionEventProm =
      promise<events.EventWebSocketServerConnection>();
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
    const connectionEventProm =
      promise<events.EventWebSocketServerConnection>();
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
      ).rejects.toHaveProperty(
        ['name'],
        errors.ErrorWebSocketConnectionLocal.name,
      );
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
          },
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
          },
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
      const peerCertChainProm = promise<Array<Uint8Array>>();
      const client1 = await WebSocketClient.createWebSocketClient({
        host: localhost,
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          verifyPeer: true,
          verifyCallback: async (peerCertChain) => {
            peerCertChainProm.resolveP(peerCertChain);
          },
        },
      });
      server.updateConfig({
        key: tlsConfig2.key,
        cert: tlsConfig2.cert,
      });

      const peerCertChainNew = await peerCertChainProm.p;

      expect(peerCertChainNew[0].buffer).toEqual(
        pemToDER(tlsConfig1.cert).buffer,
      );

      await client1.destroy();
      await server.stop();
    });
    test('new connections use new config', async () => {
      const tlsConfig1 = await testsUtils.generateConfig(type);
      const tlsConfig2 = await testsUtils.generateConfig(type);
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
      const peerCertChainProm = promise<Array<Uint8Array>>();
      const client2 = await WebSocketClient.createWebSocketClient({
        host: localhost,
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          verifyPeer: true,
          verifyCallback: async (peerCertChain) => {
            peerCertChainProm.resolveP(peerCertChain);
          },
        },
      });
      expect((await peerCertChainProm.p)[0].buffer).toEqual(
        pemToDER(tlsConfig2.cert).buffer,
      );
      await client1.destroy();
      await client2.destroy();
      await server.stop();
    });
  });
  describe.each(types)('graceful tls handshake with %s certs', (type) => {
    test('server verification succeeds', async () => {
      const tlsConfigs = await testsUtils.generateConfig(type);
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfigs.key,
          cert: tlsConfigs.cert,
          verifyPeer: false,
        },
      });
      const handleConnectionEventProm = promise<any>();
      server.addEventListener(
        events.EventWebSocketServerConnection.name,
        handleConnectionEventProm.resolveP,
      );
      await server.start({
        host: localhost,
      });
      // Connection should succeed
      const client = await WebSocketClient.createWebSocketClient({
        host: localhost,
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          verifyPeer: true,
          ca: tlsConfigs.ca,
        },
      });
      await handleConnectionEventProm.p;
      await client.destroy();
      await server.stop();
    });
    test('client verification succeeds', async () => {
      const tlsConfigs1 = await testsUtils.generateConfig(type);
      const tlsConfigs2 = await testsUtils.generateConfig(type);
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfigs1.key,
          cert: tlsConfigs1.cert,
          verifyPeer: true,
          ca: tlsConfigs2.ca,
        },
      });
      const handleConnectionEventProm = promise<any>();
      server.addEventListener(
        events.EventWebSocketServerConnection.name,
        handleConnectionEventProm.resolveP,
      );
      await server.start({
        host: localhost,
      });
      // // Connection should succeed
      const client = await WebSocketClient.createWebSocketClient({
        host: localhost,
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          key: tlsConfigs2.key,
          cert: tlsConfigs2.cert,
          verifyPeer: false,
        },
      });
      await client.destroy();
      await server.stop();
    });
    test('client and server verification succeeds', async () => {
      const tlsConfigs1 = await testsUtils.generateConfig(type);
      const tlsConfigs2 = await testsUtils.generateConfig(type);
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfigs1.key,
          cert: tlsConfigs1.cert,
          ca: tlsConfigs2.ca,
          verifyPeer: true,
        },
      });
      const handleConnectionEventProm = promise<any>();
      server.addEventListener(
        events.EventWebSocketServerConnection.name,
        handleConnectionEventProm.resolveP,
      );
      await server.start({
        host: localhost,
      });
      // Connection should succeed
      const client = await WebSocketClient.createWebSocketClient({
        host: localhost,
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          key: tlsConfigs2.key,
          cert: tlsConfigs2.cert,
          ca: tlsConfigs1.ca,
          verifyPeer: true,
        },
      });
      await handleConnectionEventProm.p;
      await client.destroy();
      await server.stop();
    });
    test('graceful failure verifying server', async () => {
      const tlsConfigs1 = await testsUtils.generateConfig(type);
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfigs1.key,
          cert: tlsConfigs1.cert,
          verifyPeer: false,
        },
      });
      await server.start({
        host: localhost,
      });
      // Connection should fail
      await expect(
        WebSocketClient.createWebSocketClient({
          host: localhost,
          port: server.port,
          logger: logger.getChild(WebSocketClient.name),
          config: {
            verifyPeer: true,
          },
        }),
      ).rejects.toHaveProperty(
        'name',
        errors.ErrorWebSocketConnectionLocalTLS.name,
      );
      await server.stop();
    });
    test('graceful failure verifying client', async () => {
      const tlsConfigs1 = await testsUtils.generateConfig(type);
      const tlsConfigs2 = await testsUtils.generateConfig(type);
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfigs1.key,
          cert: tlsConfigs1.cert,
          verifyPeer: true,
        },
      });
      await server.start({
        host: localhost,
      });
      // Connection succeeds but peer will reject shortly after
      await expect(
        WebSocketClient.createWebSocketClient({
          host: localhost,
          port: server.port,
          logger: logger.getChild(WebSocketClient.name),
          config: {
            key: tlsConfigs2.key,
            cert: tlsConfigs2.cert,
            verifyPeer: false,
          },
        }),
      ).rejects.toHaveProperty(
        'name',
        errors.ErrorWebSocketConnectionPeer.name,
      );

      await server.stop();
    });
    test('graceful failure verifying client and server', async () => {
      const tlsConfigs1 = await testsUtils.generateConfig(type);
      const tlsConfigs2 = await testsUtils.generateConfig(type);
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfigs1.key,
          cert: tlsConfigs1.cert,
          verifyPeer: true,
        },
      });
      await server.start({
        host: localhost,
      });
      // Connection should fail
      await expect(
        WebSocketClient.createWebSocketClient({
          host: localhost,
          port: server.port,
          logger: logger.getChild(WebSocketClient.name),
          config: {
            key: tlsConfigs2.key,
            cert: tlsConfigs2.cert,
            verifyPeer: true,
          },
        }),
      ).rejects.toHaveProperty(
        'name',
        errors.ErrorWebSocketConnectionLocalTLS.name,
      );

      await server.stop();
    });
  });
  describe.each(types)('custom TLS verification with %s', (type) => {
    test('server succeeds custom verification', async () => {
      const tlsConfigs = await testsUtils.generateConfig(type);
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfigs.key,
          cert: tlsConfigs.cert,
          verifyPeer: false,
        },
      });
      const handleConnectionEventProm = promise<any>();
      server.addEventListener(
        events.EventWebSocketServerConnection.name,
        handleConnectionEventProm.resolveP,
      );
      await server.start({
        host: localhost,
      });
      // Connection should succeed
      const verifyProm = promise<Array<Uint8Array> | undefined>();
      const client = await WebSocketClient.createWebSocketClient({
        host: localhost,
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          verifyPeer: true,
          verifyCallback: async (certs) => {
            verifyProm.resolveP(certs);
          },
        },
      });
      await handleConnectionEventProm.p;
      await expect(verifyProm.p).toResolve();
      await client.destroy();
      await server.stop();
    });
    test('server fails custom verification', async () => {
      const tlsConfigs = await testsUtils.generateConfig(type);
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfigs.key,
          cert: tlsConfigs.cert,
          verifyPeer: false,
        },
      });
      const handleConnectionEventProm = promise<WebSocketConnection>();
      server.addEventListener(
        events.EventWebSocketServerConnection.name,
        (event: events.EventWebSocketServerConnection) =>
          handleConnectionEventProm.resolveP(event.detail),
      );
      await server.start({
        host: localhost,
      });
      // Connection should fail
      const clientProm = WebSocketClient.createWebSocketClient({
        host: localhost,
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          verifyPeer: true,
          verifyCallback: () => {
            throw Error('SOME ERROR');
          },
        },
      });
      clientProm.catch(() => {});

      // Verification by peer happens after connection is securely established and started
      const serverConn = await handleConnectionEventProm.p;
      const serverErrorProm = promise<never>();
      serverConn.addEventListener(
        events.EventWebSocketConnectionError.name,
        (evt: events.EventWebSocketConnectionError) =>
          serverErrorProm.rejectP(evt.detail),
      );
      await expect(serverErrorProm.p).rejects.toThrow(
        errors.ErrorWebSocketConnectionPeer,
      );
      await expect(clientProm).rejects.toThrow(
        errors.ErrorWebSocketConnectionLocal,
      );

      await server.stop();
    });
    test('client succeeds custom verification', async () => {
      const tlsConfigs = await testsUtils.generateConfig(type);
      const verifyProm = promise<Array<Uint8Array> | undefined>();
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfigs.key,
          cert: tlsConfigs.cert,
          verifyPeer: true,
          verifyCallback: async (certs) => {
            verifyProm.resolveP(certs);
          },
        },
      });
      const handleConnectionEventProm = promise<any>();
      server.addEventListener(
        events.EventWebSocketServerConnection.name,
        handleConnectionEventProm.resolveP,
      );
      await server.start({
        host: localhost,
      });
      // Connection should succeed
      const client = await WebSocketClient.createWebSocketClient({
        host: localhost,
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          verifyPeer: false,
          key: tlsConfigs.key,
          cert: tlsConfigs.cert,
        },
      });
      await handleConnectionEventProm.p;
      await expect(verifyProm.p).toResolve();
      await client.destroy();
      await server.stop();
    });
    test('client fails custom verification', async () => {
      const tlsConfigs = await testsUtils.generateConfig(type);
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfigs.key,
          cert: tlsConfigs.cert,
          verifyPeer: true,
          verifyCallback: () => {
            throw Error('SOME ERROR');
          },
        },
      });
      const handleConnectionEventProm = promise<WebSocketConnection>();
      server.addEventListener(
        events.EventWebSocketServerConnection.name,
        (event: events.EventWebSocketServerConnection) =>
          handleConnectionEventProm.resolveP(event.detail),
      );
      await server.start({
        host: localhost,
      });
      // Connection should fail
      await expect(
        WebSocketClient.createWebSocketClient({
          host: localhost,
          port: server.port,
          logger: logger.getChild(WebSocketClient.name),
          config: {
            key: tlsConfigs.key,
            cert: tlsConfigs.cert,
            verifyPeer: false,
          },
        }),
      ).rejects.toHaveProperty('name', 'ErrorWebSocketConnectionPeer');

      // // Server connection is never emitted
      await Promise.race([
        handleConnectionEventProm.p.then(() => {
          throw Error('Server connection should not be emitted');
        }),
        // Allow some time
        testsUtils.sleep(200),
      ]);

      await server.stop();
    });
  });
  test('Connections are established and secured quickly', async () => {
    const tlsConfigServer = await testsUtils.generateConfig(defaultType);

    const connectionEventProm =
      promise<events.EventWebSocketServerConnection>();
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
      host: localhost,
      port: 55555,
    });
    // If the server is slow to respond then this will time out.
    //  Then main cause of this was the server not processing the initial packet
    //  that creates the `WebSocketConnection`, as a result, the whole creation waited
    //  an extra 1 second for the client to retry the initial packet.
    const client = await WebSocketClient.createWebSocketClient(
      {
        host: localhost,
        port: server.port,
        logger: logger.getChild(WebSocketClient.name),
        config: {
          verifyPeer: false,
        },
      },
      { timer: 500 },
    );
    await connectionEventProm.p;
    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  // Test('socket stopping first triggers client destruction', async () => {
  //   const tlsConfigServer = await testsUtils.generateConfig(defaultType);

  //   const connectionEventProm = promise<WebSocketConnection>();
  //   const server = new WebSocketServer({
  //     logger: logger.getChild(WebSocketServer.name),
  //     config: {
  //       key: tlsConfigServer.key,
  //       cert: tlsConfigServer.cert,
  //       verifyPeer: false,
  //     },
  //   });
  //   server.addEventListener(
  //     events.EventWebSocketServerConnection.name,
  //     (e: events.EventWebSocketServerConnection) => connectionEventProm.resolveP(e.detail),
  //   );
  //   await server.start({
  //     host: localhost,
  //     port: 55555,
  //   });
  //   // If the server is slow to respond then this will time out.
  //   //  Then main cause of this was the server not processing the initial packet
  //   //  that creates the `WebSocketConnection`, as a result, the whole creation waited
  //   //  an extra 1 second for the client to retry the initial packet.
  //   const client = await WebSocketClient.createWebSocketClient(
  //     {
  //       host: localhost,
  //       port: server.port,
  //       logger: logger.getChild(WebSocketClient.name),
  //       config: {
  //         verifyPeer: false,
  //       },
  //     });

  //   const serverConnection = await connectionEventProm.p;
  //   // handling server connection error event
  //   const serverConnectionErrorProm = promise<never>();
  //   serverConnection.addEventListener(
  //     events.EventWebSocketConnectionError.name,
  //     (evt: events.EventWebSocketConnectionError) => serverConnectionErrorProm.rejectP(evt.detail),
  //     {once: true},
  //   );

  //   // Handling client connection error event
  //   const clientConnectionErrorProm = promise<never>();
  //   client.connection.addEventListener(
  //     events.EventWebSocketConnectionError.name,
  //     (evt: events.EventWebSocketConnectionError) => clientConnectionErrorProm.rejectP(evt.detail),
  //     {once: true},
  //   );

  //   // handling client destroy event
  //   const clientConnectionStoppedProm = promise<void>();
  //   client.connection.addEventListener(
  //     events.EventWebSocketConnectionStopped.name,
  //     () => clientConnectionStoppedProm.resolveP(),
  //     {once: true},
  //   );

  //   // handling client error event
  //   const clientErrorProm = promise<never>();
  //   client.addEventListener(
  //     events.EventWebSocketClientError.name,
  //     (evt: events.EventWebSocketClientError) => clientErrorProm.rejectP(evt.detail),
  //     {once: true},
  //   );

  //   // handling client destroy event
  //   const clientDestroyedProm = promise<void>();
  //   client.addEventListener(
  //     events.EventWebSocketClientDestroyed.name,
  //     () => clientDestroyedProm.resolveP(),
  //     {once: true},
  //   );

  //   // Socket failure triggers client connection local failure
  //   await expect(clientConnectionErrorProm.p).rejects.toThrow(errors.ErrorWebSocketConnectionLocal);
  //   await expect(clientErrorProm.p).rejects.toThrow(errors.ErrorWebSocketClientSocketNotRunning);
  //   await clientDestroyedProm.p;
  //   await clientConnectionStoppedProm.p;

  //   // Socket failure will not trigger any close frame since transport has failed so server connection will time out
  //   await expect(serverConnectionErrorProm.p).rejects.toThrow(errors.ErrorWebSocketConnectionIdleTimeout);

  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // })
});
