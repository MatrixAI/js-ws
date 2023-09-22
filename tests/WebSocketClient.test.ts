import { promise, pemToDER, ConnectionErrorCode } from "@/utils";
import * as events from '@/events';
import * as errors from '@/errors';
import * as testsUtils from './utils';
import WebSocketClient from "@/WebSocketClient";
import Logger, { formatting, LogLevel, StreamHandler } from "@matrixai/logger";
import { X509Certificate } from "@peculiar/x509";
import WebSocketServer from "@/WebSocketServer";
import { KeyTypes } from "./utils";
import { DetailedPeerCertificate } from "tls";
import { fc, testProp } from "@fast-check/jest";

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
      let peerCertChainProm = promise<Array<Uint8Array>>();
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
      let peerCertChainProm = promise<Array<Uint8Array>>();
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
      expect((await peerCertChainProm.p)[0].buffer).toEqual(pemToDER(tlsConfig2.cert).buffer);
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
      ).toReject();
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
      // connection succeeds but peer will reject shortly after
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
        })
      ).toReject();

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
      ).toReject();

      await server.stop();
    });
  });
  // describe('handles random packets', () => {
  //   testProp(
  //     'client handles random noise from server',
  //     [
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //     ],
  //     async (data, messages) => {
  //       const tlsConfig = await testsUtils.generateConfig('RSA');
  //       const server = new WebSocketServer({
  //         logger: logger.getChild(WebSocketServer.name),
  //         config: {
  //           key: tlsConfig.key,
  //           cert: tlsConfig.cert,
  //           verifyPeer: false,
  //         },
  //       });
  //       const connectionEventProm = promise<events.EventWebSocketServerConnection>();
  //       server.addEventListener(
  //         events.EventWebSocketServerConnection.name,
  //         (e: events.EventWebSocketServerConnection) =>
  //           connectionEventProm.resolveP(e),
  //       );
  //       await server.start({
  //         host: localhost,
  //       });
  //       const client = await WebSocketClient.createWebSocketClient({
  //         host: '::ffff:127.0.0.1',
  //         port: server.port,
  //         logger: logger.getChild(WebSocketClient.name),
  //         config: {
  //           verifyPeer: false,
  //         },
  //       });
  //       const conn = (await connectionEventProm.p).detail;
  //       // Do the test
  //       const serverStreamProms: Array<Promise<void>> = [];
  //       conn.addEventListener(
  //         events.EventWebSocketConnectionStream.name,
  //         (streamEvent: events.EventWebSocketConnectionStream) => {
  //           const stream = streamEvent.detail;
  //           const streamProm = stream.readable.pipeTo(stream.writable);
  //           serverStreamProms.push(streamProm);
  //         },
  //       );
  //       // Sending random data to client from the perspective of the server
  //       let running = true;
  //       const randomDataProm = (async () => {
  //         let count = 0;
  //         while (running) {
  //           await socket.send(
  //             data[count % data.length],
  //             client.localPort,
  //             '127.0.0.1',
  //           );
  //           await sleep(5);
  //           count += 1;
  //         }
  //       })();
  //       // We want to check that things function fine between bad data
  //       const randomActivityProm = (async () => {
  //         const stream = await client.connection.newStream();
  //         await Promise.all([
  //           (async () => {
  //             // Write data
  //             const writer = stream.writable.getWriter();
  //             for (const message of messages) {
  //               await writer.write(message);
  //               await sleep(7);
  //             }
  //             await writer.close();
  //           })(),
  //           (async () => {
  //             // Consume readable
  //             for await (const _ of stream.readable) {
  //               // Do nothing
  //             }
  //           })(),
  //         ]);
  //         running = false;
  //       })();
  //       // Wait for running activity to finish, should complete without error
  //       await Promise.all([
  //         randomActivityProm,
  //         serverStreamProms,
  //         randomDataProm,
  //       ]);
  //       await client.destroy({ force: true });
  //       await server.stop();
  //       await socket.stop();
  //     },
  //     { numRuns: 1 },
  //   );
  //   testProp(
  //     'client handles random noise from external',
  //     [
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //     ],
  //     async (data, messages) => {
  //       const tlsConfig = await testsUtils.generateConfig('RSA');
  //       const socket = new WebSocketSocket({
  //         logger: logger.getChild('socket'),
  //       });
  //       await socket.start({
  //         host: localhost,
  //       });
  //       const server = new WebSocketServer({
  //         crypto: {
  //           key,
  //           ops: serverCryptoOps,
  //         },
  //         logger: logger.getChild(WebSocketServer.name),
  //         config: {
  //           key: tlsConfig.key,
  //           cert: tlsConfig.cert,
  //           verifyPeer: false,
  //         },
  //       });
  //       socketCleanMethods.extractSocket(server);
  //       const connectionEventProm = promise<events.EventWebSocketServerConnection>();
  //       server.addEventListener(
  //         events.EventWebSocketServerConnection.name,
  //         (e: events.EventWebSocketServerConnection) =>
  //           connectionEventProm.resolveP(e),
  //       );
  //       await server.start({
  //         host: localhost,
  //       });
  //       const client = await WebSocketClient.createWebSocketClient({
  //         host: '::ffff:127.0.0.1',
  //         port: server.port,
  //         localHost: '::',
  //         crypto: {
  //           ops: clientCryptoOps,
  //         },
  //         logger: logger.getChild(WebSocketClient.name),
  //         config: {
  //           verifyPeer: false,
  //         },
  //       });
  //       socketCleanMethods.extractSocket(client);
  //       const conn = (await connectionEventProm.p).detail;
  //       // Do the test
  //       const serverStreamProms: Array<Promise<void>> = [];
  //       conn.addEventListener(
  //         events.EventWebSocketConnectionStream.name,
  //         (streamEvent: events.EventWebSocketConnectionStream) => {
  //           const stream = streamEvent.detail;
  //           const streamProm = stream.readable.pipeTo(stream.writable);
  //           serverStreamProms.push(streamProm);
  //         },
  //       );
  //       // Sending random data to client from the perspective of the server
  //       let running = true;
  //       const randomDataProm = (async () => {
  //         let count = 0;
  //         while (running) {
  //           await socket.send(
  //             data[count % data.length],
  //             client.localPort,
  //             '127.0.0.1',
  //           );
  //           await sleep(5);
  //           count += 1;
  //         }
  //       })();
  //       // We want to check that things function fine between bad data
  //       const randomActivityProm = (async () => {
  //         const stream = await client.connection.newStream();
  //         await Promise.all([
  //           (async () => {
  //             // Write data
  //             const writer = stream.writable.getWriter();
  //             for (const message of messages) {
  //               await writer.write(message);
  //               await sleep(7);
  //             }
  //             await writer.close();
  //           })(),
  //           (async () => {
  //             // Consume readable
  //             for await (const _ of stream.readable) {
  //               // Do nothing
  //             }
  //           })(),
  //         ]);
  //         running = false;
  //       })();
  //       // Wait for running activity to finish, should complete without error
  //       await Promise.all([
  //         randomActivityProm,
  //         serverStreamProms,
  //         randomDataProm,
  //       ]);
  //       await client.destroy({ force: true });
  //       await server.stop();
  //       await socket.stop();
  //     },
  //     { numRuns: 1 },
  //   );
  //   testProp(
  //     'server handles random noise from client',
  //     [
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //     ],
  //     async (data, messages) => {
  //       const tlsConfig = await testsUtils.generateConfig('RSA');
  //       const socket = new WebSocketSocket({
  //         logger: logger.getChild('socket'),
  //       });
  //       await socket.start({
  //         host: localhost,
  //       });
  //       const server = new WebSocketServer({
  //         crypto: {
  //           key,
  //           ops: serverCryptoOps,
  //         },
  //         logger: logger.getChild(WebSocketServer.name),
  //         config: {
  //           key: tlsConfig.key,
  //           cert: tlsConfig.cert,
  //           verifyPeer: false,
  //         },
  //       });
  //       socketCleanMethods.extractSocket(server);
  //       const connectionEventProm = promise<events.EventWebSocketServerConnection>();
  //       server.addEventListener(
  //         events.EventWebSocketServerConnection.name,
  //         (e: events.EventWebSocketServerConnection) =>
  //           connectionEventProm.resolveP(e),
  //       );
  //       await server.start({
  //         host: localhost,
  //       });
  //       const client = await WebSocketClient.createWebSocketClient({
  //         host: localhost,
  //         port: server.port,
  //         socket,
  //         crypto: {
  //           ops: clientCryptoOps,
  //         },
  //         logger: logger.getChild(WebSocketClient.name),
  //         config: {
  //           verifyPeer: false,
  //         },
  //       });
  //       socketCleanMethods.extractSocket(client);
  //       const conn = (await connectionEventProm.p).detail;
  //       // Do the test
  //       const serverStreamProms: Array<Promise<void>> = [];
  //       conn.addEventListener(
  //         events.EventWebSocketConnectionStream.name,
  //         (streamEvent: events.EventWebSocketConnectionStream) => {
  //           const stream = streamEvent.detail;
  //           const streamProm = stream.readable.pipeTo(stream.writable);
  //           serverStreamProms.push(streamProm);
  //         },
  //       );
  //       // Sending random data to client from the perspective of the server
  //       let running = true;
  //       const randomDataProm = (async () => {
  //         let count = 0;
  //         while (running) {
  //           await socket.send(
  //             data[count % data.length],
  //             server.port,
  //             '127.0.0.1',
  //           );
  //           await sleep(5);
  //           count += 1;
  //         }
  //       })();
  //       // We want to check that things function fine between bad data
  //       const randomActivityProm = (async () => {
  //         const stream = await client.connection.newStream();
  //         await Promise.all([
  //           (async () => {
  //             // Write data
  //             const writer = stream.writable.getWriter();
  //             for (const message of messages) {
  //               await writer.write(message);
  //               await sleep(7);
  //             }
  //             await writer.close();
  //           })(),
  //           (async () => {
  //             // Consume readable
  //             for await (const _ of stream.readable) {
  //               // Do nothing
  //             }
  //           })(),
  //         ]);
  //         running = false;
  //       })();
  //       // Wait for running activity to finish, should complete without error
  //       await Promise.all([
  //         randomActivityProm,
  //         serverStreamProms,
  //         randomDataProm,
  //       ]);
  //       await client.destroy({ force: true });
  //       await server.stop();
  //       await socket.stop();
  //     },
  //     { numRuns: 1 },
  //   );
  //   testProp(
  //     'server handles random noise from external',
  //     [
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //     ],
  //     async (data, messages) => {
  //       const tlsConfig = await testsUtils.generateConfig('RSA');
  //       const socket = new WebSocketSocket({
  //         logger: logger.getChild('socket'),
  //       });
  //       await socket.start({
  //         host: localhost,
  //       });
  //       const server = new WebSocketServer({
  //         crypto: {
  //           key,
  //           ops: serverCryptoOps,
  //         },
  //         logger: logger.getChild(WebSocketServer.name),
  //         config: {
  //           key: tlsConfig.key,
  //           cert: tlsConfig.cert,
  //           verifyPeer: false,
  //         },
  //       });
  //       socketCleanMethods.extractSocket(server);
  //       const connectionEventProm = promise<events.EventWebSocketServerConnection>();
  //       server.addEventListener(
  //         events.EventWebSocketServerConnection.name,
  //         (e: events.EventWebSocketServerConnection) =>
  //           connectionEventProm.resolveP(e),
  //       );
  //       await server.start({
  //         host: localhost,
  //       });
  //       const client = await WebSocketClient.createWebSocketClient({
  //         host: localhost,
  //         port: server.port,
  //         localHost: localhost,
  //         crypto: {
  //           ops: clientCryptoOps,
  //         },
  //         logger: logger.getChild(WebSocketClient.name),
  //         config: {
  //           verifyPeer: false,
  //         },
  //       });
  //       socketCleanMethods.extractSocket(client);
  //       const conn = (await connectionEventProm.p).detail;
  //       // Do the test
  //       const serverStreamProms: Array<Promise<void>> = [];
  //       conn.addEventListener(
  //         events.EventWebSocketConnectionStream.name,
  //         (streamEvent: events.EventWebSocketConnectionStream) => {
  //           const stream = streamEvent.detail;
  //           const streamProm = stream.readable.pipeTo(stream.writable);
  //           serverStreamProms.push(streamProm);
  //         },
  //       );
  //       // Sending random data to client from the perspective of the server
  //       let running = true;
  //       const randomDataProm = (async () => {
  //         let count = 0;
  //         while (running) {
  //           await socket.send(
  //             data[count % data.length],
  //             server.port,
  //             '127.0.0.1',
  //           );
  //           await sleep(5);
  //           count += 1;
  //         }
  //       })();
  //       // We want to check that things function fine between bad data
  //       const randomActivityProm = (async () => {
  //         const stream = await client.connection.newStream();
  //         await Promise.all([
  //           (async () => {
  //             // Write data
  //             const writer = stream.writable.getWriter();
  //             for (const message of messages) {
  //               await writer.write(message);
  //               await sleep(7);
  //             }
  //             await writer.close();
  //           })(),
  //           (async () => {
  //             // Consume readable
  //             for await (const _ of stream.readable) {
  //               // Do nothing
  //             }
  //           })(),
  //         ]);
  //         running = false;
  //       })();
  //       // Wait for running activity to finish, should complete without error
  //       await Promise.all([
  //         randomActivityProm,
  //         serverStreamProms,
  //         randomDataProm,
  //       ]);
  //       await client.destroy({ force: true });
  //       await server.stop();
  //       await socket.stop();
  //     },
  //     { numRuns: 1 },
  //   );
  // });
});
