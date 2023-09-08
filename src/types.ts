import type { DetailedPeerCertificate } from 'tls';

/**
 * Opaque types are wrappers of existing types
 * that require smart constructors
 */
type Opaque<K, T> = T & { readonly [brand]: K };
declare const brand: unique symbol;

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

type RemoteInfo = {
  host: Host;
  port: Port;
};

/**
 * Maps reason (most likely an exception) to a stream code.
 * Use `0` to indicate unknown/default reason.
 */
type StreamReasonToCode = (
  type: 'recv' | 'send',
  reason?: any,
) => bigint | PromiseLike<bigint>;

/**
 * Maps code to a reason. 0 usually indicates unknown/default reason.
 */
type StreamCodeToReason = (
  type: 'recv' | 'send',
  code: bigint,
) => any | PromiseLike<any>;

type ConnectionMetadata = {
  localHost?: string;
  localPort?: number;
  remoteHost: string;
  remotePort: number;
  peerCert?: DetailedPeerCertificate;
};

type VerifyCallback = (peerCert: DetailedPeerCertificate) => Promise<void>;

type WebSocketConfig = {
  connectTimeoutTime: number;
  keepAliveTimeoutTime: number;
  keepAliveIntervalTime: number;
  /**
   * Maximum number of bytes for the readable stream
   */
  streamBufferSize: number;
};

interface Parsed<T> {
  data: T;
  remainder: Uint8Array;
}

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
  VerifyCallback,
  WebSocketConfig,
  Parsed,
};
