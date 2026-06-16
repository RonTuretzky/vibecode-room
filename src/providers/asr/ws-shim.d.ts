declare module "ws" {
  export type RawData = ArrayBuffer | Buffer | Buffer[] | Uint8Array | string;

  export interface WebSocketOptions {
    headers?: Record<string, string>;
  }

  export default class WebSocket {
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    static readonly CLOSING: number;
    static readonly CLOSED: number;

    readonly readyState: number;

    constructor(address: string | URL, options?: WebSocketOptions);

    on(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: RawData) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    send(data: string | Uint8Array | ArrayBuffer): void;
    close(code?: number, reason?: string): void;
  }
}
