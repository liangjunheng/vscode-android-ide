import * as net from 'net';

import { logger } from './logger';

export class JDWP {
    private socket: net.Socket;

    private port: number;
    private host: string;
    private socketClosed = false;
    private disconnectPromise: Promise<void> | undefined;

    /** 为指定host/port创建自有socket并记录实际close；native-runtime.test.js以本地net及可控socket验证关闭结算。 */
    constructor(port: number, host: string) {
        this.port = port;
        this.host = host;

        this.socket = new net.Socket();
        this.socket.once("close", () => { this.socketClosed = true; });
    }

    // 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言连接/分段读取/交错回复/关闭与错误传播。
    /** 连接指定端口并验证JDWP握手，失败等待断开且保留双重错误；native-runtime.test.js断言握手、提前关闭和清理失败。 */
    async connect() {
        await new Promise<void>((resolve, reject) => {
            this.socket.on("error", reject);
            this.socket.connect(this.port, this.host, () =>  {
                this.socket.off("error", reject);
                resolve();
            });
        });
        try {
            await this.handshake();
        }
        catch (e: any) {
            logger.log(`Error in JDWP handshake: ${e}`);
            try {
                await this.disconnect();
            } catch (cleanupError) {
                throw new AggregateError([e, cleanupError], "JDWP handshake and cleanup failed");
            }
            throw new Error("Could not successfully complete JDWP handshake", {cause: e});
        }
    }

    /**
     * 主动关闭 JDWP socket，并等待 close 事件，避免 forward 清理先行导致资源泄漏。
     */
    // 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言连接/分段读取/交错回复/关闭与错误传播。
    async disconnect(): Promise<void> {
        if (this.socketClosed) return;
        if (!this.disconnectPromise) {
            this.disconnectPromise = new Promise<void>((resolve, reject) => {
                const finish = (error?: Error) => {
                    this.socket.off("close", onClose);
                    this.socket.off("error", onError);
                    if (error) reject(error); else resolve();
                };
                const onClose = () => finish();
                const onError = (error: Error) => finish(error);
                this.socket.once("close", onClose);
                this.socket.once("error", onError);
                this.socket.end();
                this.socket.destroy();
            });
        }
        await this.disconnectPromise;
    }

    /** 读取指定字节数并监听 readable、error、end、close，连接异常不会悬挂。 */
    // 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言连接/分段读取/交错回复/关闭与错误传播。
    private async read(size: number, timeout?: number): Promise<Buffer> {
        if (this.socket.readableLength >= size) {
            const value = this.socket.read(size);
            if (value) return value;
        }
        return await new Promise<Buffer>((resolve, reject) => {
            let timeoutId: NodeJS.Timeout | undefined;
            let settled = false;
            const cleanup = () => {
                if (timeoutId) clearTimeout(timeoutId);
                this.socket.off("readable", onReadable);
                this.socket.off("error", onError);
                this.socket.off("end", onEnd);
                this.socket.off("close", onClose);
            };
            const finish = (error?: Error, value?: Buffer) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error);
                else if (value) resolve(value);
                else reject(new Error("Could not read data in specified time"));
            };
            const tryRead = () => {
                if (this.socket.readableLength < size) return;
                const value = this.socket.read(size);
                if (value) finish(undefined, value);
            };
            const onReadable = () => tryRead();
            const onError = (error: Error) => finish(error);
            const onEnd = () => finish(new Error("JDWP socket ended while reading"));
            const onClose = () => finish(new Error("JDWP socket closed while reading"));
            this.socket.on("readable", onReadable);
            this.socket.once("error", onError);
            this.socket.once("end", onEnd);
            this.socket.once("close", onClose);
            if (timeout) timeoutId = setTimeout(() => finish(), timeout);
            tryRead();
        });
    }

    /** 写入 JDWP 数据并等待 flush；写入期间的 error/close 直接拒绝。 */
    // 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言连接/分段读取/交错回复/关闭与错误传播。
    /** 写入协议数据并结算错误/close监听；native-runtime.test.js通过真实握手/resume及关闭用例断言结果。 */
    private async write(data: Buffer | string): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                this.socket.off("error", onError);
                this.socket.off("close", onClose);
            };
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error); else resolve();
            };
            const onError = (error: Error) => finish(error);
            const onClose = () => finish(new Error("JDWP socket closed while writing"));
            this.socket.once("error", onError);
            this.socket.once("close", onClose);
            try {
                this.socket.write(data, () => finish());
            } catch (error) {
                finish(error as Error);
            }
        });
    }

    /** 发送并校验原JDWP握手字节，非法回复失败；native-runtime.test.js覆盖真实成功及可控错误回复。 */
    private async handshake() {
        const handshake = 'JDWP-Handshake';
        await this.write(handshake);

        const reply = (await this.read(handshake.length, 30000)).toString('latin1');
        if (reply !== handshake) {
            throw new Error("JDWP Handshake failed");
        }
    }

    // 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言连接/分段读取/交错回复/关闭与错误传播。
    /** 已连接后发送原VM.Resume包并等待对应成功回复；native-runtime.test.js断言交错包、分段回复及提前关闭。 */
    async resume() {
        const commandId = 0;

        const buf = Buffer.allocUnsafe(11);
        buf.writeUInt32BE(11, 0);   // length
        buf.writeUInt32BE(commandId, 4);    // id
        buf[8] = 0;     // flags
        buf[9] = 1;     // command set
        buf[10] = 9;    // command

        await this.write(buf);
        await this.waitForResumeReply(commandId);

    }

    /** 读取完整 JDWP 回复包，跳过交错事件或其他命令直到目标 id。 */
    // 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言连接/分段读取/交错回复/关闭与错误传播。
    private async waitForResumeReply(commandId: number): Promise<void> {
        while (true) {
            const length = (await this.read(4)).readUInt32BE(0);
            if (length < 11) throw new Error(`Invalid JDWP packet length ${length}`);
            const id = (await this.read(4)).readUInt32BE(0);
            const flags = (await this.read(1))[0];
            const errorcode = (await this.read(2)).readUInt16BE(0);
            if (length > 11) await this.read(length - 11);
            if (id !== commandId) continue;
            if ((flags & 0x80) === 0) throw new Error(`JDWP: Expected reply flag, got ${flags}`);
            if (errorcode !== 0) throw new Error(`Java resume failed with error ${errorcode}`);
            return;
        }
    }}