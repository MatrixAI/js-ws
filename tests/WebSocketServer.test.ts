import type { X509Certificate } from '@peculiar/x509';
import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import WebSocketServer from '@/WebSocketServer';
import * as testsUtils from './utils';

describe(WebSocketServer.name, () => {
  const logger = new Logger(`${WebSocketServer.name} Test`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  let keyPairRSA: {
    publicKey: JsonWebKey;
    privateKey: JsonWebKey;
  };
  let certRSA: X509Certificate;
  let keyPairRSAPEM: {
    publicKey: string;
    privateKey: string;
  };
  let certRSAPEM: string;
  let keyPairECDSA: {
    publicKey: JsonWebKey;
    privateKey: JsonWebKey;
  };
  let certECDSA: X509Certificate;
  let keyPairECDSAPEM: {
    publicKey: string;
    privateKey: string;
  };
  let certECDSAPEM: string;
  let keyPairEd25519: {
    publicKey: JsonWebKey;
    privateKey: JsonWebKey;
  };
  let certEd25519: X509Certificate;
  let keyPairEd25519PEM: {
    publicKey: string;
    privateKey: string;
  };
  let certEd25519PEM: string;
  beforeAll(async () => {
    keyPairRSA = await testsUtils.generateKeyPairRSA();
    certRSA = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairRSA,
      issuerPrivateKey: keyPairRSA.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    keyPairRSAPEM = await testsUtils.keyPairRSAToPEM(keyPairRSA);
    certRSAPEM = testsUtils.certToPEM(certRSA);
    keyPairECDSA = await testsUtils.generateKeyPairECDSA();
    certECDSA = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairECDSA,
      issuerPrivateKey: keyPairECDSA.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    keyPairECDSAPEM = await testsUtils.keyPairECDSAToPEM(keyPairECDSA);
    certECDSAPEM = testsUtils.certToPEM(certECDSA);
    keyPairEd25519 = await testsUtils.generateKeyPairEd25519();
    certEd25519 = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairEd25519,
      issuerPrivateKey: keyPairEd25519.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    keyPairEd25519PEM = await testsUtils.keyPairEd25519ToPEM(keyPairEd25519);
    certEd25519PEM = testsUtils.certToPEM(certEd25519);
  });
  // This has to be setup asynchronously due to key generation
  let key: ArrayBuffer;
  beforeEach(async () => {
    key = await testsUtils.generateKeyHMAC();
  });

  describe('start and stop', () => {
    test('with RSA', async () => {
      const webSocketServer = new WebSocketServer({
        config: {
          key: keyPairRSAPEM.privateKey,
          cert: certRSAPEM,
        },
        logger: logger.getChild('WebSocketServer'),
      });
      await webSocketServer.start();
      // Default to dual-stack
      expect(webSocketServer.host).toBe('::');
      expect(typeof webSocketServer.port).toBe('number');
      await webSocketServer.stop();
    });
    test('with ECDSA', async () => {
      const webSocketServer = new WebSocketServer({
        config: {
          key: keyPairECDSAPEM.privateKey,
          cert: certECDSAPEM,
        },
        logger: logger.getChild('WebSocketServer'),
      });
      await webSocketServer.start();
      // Default to dual-stack
      expect(webSocketServer.host).toBe('::');
      expect(typeof webSocketServer.port).toBe('number');
      await webSocketServer.stop();
    });
    test('with Ed25519', async () => {
      const webSocketServer = new WebSocketServer({
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('WebSocketServer'),
      });
      await webSocketServer.start();
      // Default to dual-stack
      expect(webSocketServer.host).toBe('::');
      expect(typeof webSocketServer.port).toBe('number');
      await webSocketServer.stop();
    });
  });
  describe('binding to host and port', () => {
    test('listen on IPv4', async () => {
      const webSocketServer = new WebSocketServer({
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('WebSocketServer'),
      });
      await webSocketServer.start({
        host: '127.0.0.1',
      });
      expect(webSocketServer.host).toBe('127.0.0.1');
      expect(typeof webSocketServer.port).toBe('number');
      await webSocketServer.stop();
    });
    test('listen on IPv6', async () => {
      const webSocketServer = new WebSocketServer({
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('WebSocketServer'),
      });
      await webSocketServer.start({
        host: '::1',
      });
      expect(webSocketServer.host).toBe('::1');
      expect(typeof webSocketServer.port).toBe('number');
      await webSocketServer.stop();
    });
    test('listen on dual stack', async () => {
      const webSocketServer = new WebSocketServer({
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('WebSocketServer'),
      });
      await webSocketServer.start({
        host: '::',
      });
      expect(webSocketServer.host).toBe('::');
      expect(typeof webSocketServer.port).toBe('number');
      await webSocketServer.stop();
    });
    test('listen on IPv4 mapped IPv6', async () => {
      // NOT RECOMMENDED, because send addresses will have to be mapped
      // addresses, which means you can ONLY connect to mapped addresses
      let webSocketServer = new WebSocketServer({
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('WebSocketServer'),
      });
      await webSocketServer.start({
        host: '::ffff:127.0.0.1',
      });
      expect(webSocketServer.host).toBe('::ffff:127.0.0.1');
      expect(typeof webSocketServer.port).toBe('number');
      await webSocketServer.stop();
      webSocketServer = new WebSocketServer({
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('WebSocketServer'),
      });
      await webSocketServer.start({
        host: '::ffff:7f00:1',
      });
      // Will resolve to dotted-decimal variant
      expect(webSocketServer.host).toBe('::ffff:127.0.0.1');
      expect(typeof webSocketServer.port).toBe('number');
      await webSocketServer.stop();
    });
    // Test('listen on hostname', async () => {
    //   const webSocketServer = new WebSocketServer({
    //     config: {
    //       key: keyPairEd25519PEM.privateKey,
    //       cert: certEd25519PEM,
    //     },
    //     logger: logger.getChild('WebSocketServer'),
    //   });
    //   await webSocketServer.start({
    //     host: 'localhost',
    //   });
    //   // Default to using dns lookup, which uses the OS DNS resolver
    //   const host = await utils.resolveHostname('localhost');
    //   expect(webSocketServer.host).toBe(host);
    //   expect(typeof webSocketServer.port).toBe('number');
    //   await webSocketServer.stop();
    // });
    // test('listen on hostname and custom resolver', async () => {
    //   const webSocketServer = new WebSocketServer({
    //     config: {
    //       key: keyPairEd25519PEM.privateKey,
    //       cert: certEd25519PEM,
    //     },
    //     resolveHostname: () => '127.0.0.1' as Host,
    //     logger: logger.getChild('WebSocketServer'),
    //   });
    //   await webSocketServer.start({
    //     host: 'abcdef',
    //   });
    //   expect(webSocketServer.host).toBe('127.0.0.1');
    //   expect(typeof webSocketServer.port).toBe('number');
    //   await webSocketServer.stop();
    // });
  });
});
