import type { DetailedPeerCertificate } from 'tls';

// Async

/**
 * Generic callback
 */
type Callback<P extends Array<any> = [], R = any, E extends Error = Error> = {
  (e: E, ...params: Partial<P>): R;
  (e?: null | undefined, ...params: P): R;
};

/**
 * Deconstructed promise
 */
type PromiseDeconstructed<T> = {
  p: Promise<T>;
  resolveP: (value: T | PromiseLike<T>) => void;
  rejectP: (reason?: any) => void;
};

// Opaque

/**
 * Opaque types are wrappers of existing types
 * that require smart constructors
 */
type Opaque<K, T> = T & { readonly [brand]: K };
declare const brand: unique symbol;

type ConnectionId = Opaque<'ConnectionId', number>;

/**
 * Host is always an IP address
 */
type Host = Opaque<'Host', string>;

/**
 * Hostnames are resolved to IP addresses
 */
type Hostname = Opaque<'Hostname', string>;

/**
 * Ports are numbers from 0 to 65535
 */
type Port = Opaque<'Port', number>;

/**
 * Combination of `<HOST>:<PORT>`
 */
type Address = Opaque<'Address', string>;

// Misc

type RemoteInfo = {
  host: Host;
  port: Port;
};

/**
 * Maps reason (most likely an exception) to a stream code.
 * Use `0` to indicate unknown/default reason.
 */
type StreamReasonToCode = (type: 'read' | 'write', reason?: any) => bigint;

/**
 * Maps code to a reason. 0 usually indicates unknown/default reason.
 */
type StreamCodeToReason = (type: 'read' | 'write', code: bigint) => any;

type ConnectionMetadata = {
  localHost?: string;
  localPort?: number;
  remoteHost: string;
  remotePort: number;
  localCertsChain: Array<Uint8Array>;
  localCACertsChain: Array<Uint8Array>;
  remoteCertsChain: Array<Uint8Array>;
};

type TLSVerifyCallback = (
  certs: Array<Uint8Array>,
  ca: Array<Uint8Array>,
) => PromiseLike<void>;

type WebSocketConfig = {
  /**
   * Certificate authority certificate in PEM format or Uint8Array buffer
   * containing PEM formatted certificate. Each string or Uint8Array can be
   * one certificate or multiple certificates concatenated together. The order
   * does not matter, each is an independent certificate authority. Multiple
   * concatenated certificate authorities can be passed. They are all
   * concatenated together.
   *
   * When this is not set, this defaults to the operating system's CA
   * certificates. OpenSSL (and forks of OpenSSL) all support the
   * environment variables `SSL_CERT_DIR` and `SSL_CERT_FILE`.
   */
  ca?: string | Array<string> | Uint8Array | Array<Uint8Array>;

  /**
   * Private key as a PEM string or Uint8Array buffer containing PEM formatted
   * key. You can pass multiple keys. The number of keys must match the number
   * of certs. Each key must be associated to the the corresponding cert chain.
   *
   * Currently multiple key and certificate chains is not supported.
   */
  key?: string | Array<string> | Uint8Array | Array<Uint8Array>;

  /**
   * X.509 certificate chain in PEM format or Uint8Array buffer containing
   * PEM formatted certificate chain. Each string or Uint8Array is a
   * certificate chain in subject to issuer order. Multiple certificate chains
   * can be passed. The number of certificate chains must match the number of
   * keys. Each certificate chain must be associated to the corresponding key.
   *
   * Currently multiple key and certificate chains is not supported.
   */
  cert?: string | Array<string> | Uint8Array | Array<Uint8Array>;

  /**
   * Verify the other peer.
   * Clients by default set this to true.
   * Servers by default set this to false.
   * Servers will not request peer certs unless this is true.
   * Server certs are always sent
   */
  verifyPeer: boolean;

  /**
   * Custom TLS verification callback.
   * It is expected that the callback will throw an error if the verification
   * fails.
   * Will be ignored if `verifyPeer` is false.
   */
  verifyCallback?: TLSVerifyCallback;

  keepAliveTimeoutTime: number;
  /**
   * This controls the interval for keeping alive an idle connection.
   * This time will be used to send a ping frame to keep the connection alive.
   * This is only useful if the `maxIdleTimeout` is set to greater than 0.
   * This is defaulted to `undefined`.
   * This is not a quiche option.
   */
  keepAliveIntervalTime: number;
  /**
   * Maximum number of bytes for the readable stream
   */
  streamBufferSize: number;
};

type WebSocketClientConfigInput = Partial<WebSocketConfig>;

type WebSocketServerConfigInput = Partial<WebSocketConfig> & {
  key: string | Array<string> | Uint8Array | Array<Uint8Array>;
  cert: string | Array<string> | Uint8Array | Array<Uint8Array>;
};

interface Parsed<T> {
  data: T;
  remainder: Uint8Array;
}

type ConnectionError = {
  errorCode: number;
  reason: string;
};

export type {
  Opaque,
  Callback,
  PromiseDeconstructed,
  ConnectionId,
  Host,
  Hostname,
  Port,
  Address,
  RemoteInfo,
  StreamReasonToCode,
  StreamCodeToReason,
  ConnectionMetadata,
  TLSVerifyCallback,
  WebSocketConfig,
  WebSocketClientConfigInput,
  WebSocketServerConfigInput,
  Parsed,
  ConnectionError
};
