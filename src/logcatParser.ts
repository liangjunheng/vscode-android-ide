/**
 * ADB logcat -B 的 logger_entry 增量解析器；按 len/hdr_size 消费完整 record，绝不以消息内容或换行猜边界。
 * 回归映射：tests/logcat-parser.test.js 覆盖 v1/v2/v3/v4、分片 UTF-8、多行/空行、批次和坏帧。
 */
export interface BinaryLogRecord {
  pid: number;
  tid: number;
  sec: number;
  nsec: number;
  priority: number;
  tag: string;
  message: string;
}

export type BinaryLogcatStatus = (text: string) => void;

const HEADER_SIZES = new Set([20, 24, 28]);

export class BinaryLogcatParser {
  private pending = Buffer.alloc(0);
  private failed = false;

  /** 输入完整记录与状态回调；前置为调用方按当前进程所有权接收输出，结果不抛异常而通过 status 回调报告坏帧。 */
  constructor(private readonly onRecord: (record: BinaryLogRecord) => void, private readonly onStatus: BinaryLogcatStatus) {}

  /**
   * 输入任意 stdout 字节片段，输出零到多条完整记录；前置为 parser 未遇到坏帧，结果按物理 record 顺序回调。
   * 回归：分字节 UTF-8/粘包/拆包测试确保 payload 原样保留，坏帧立即产生显式 status。
   */
  push(chunk: Buffer): void {
    if (this.failed || !chunk.length) return;
    this.pending = Buffer.concat([this.pending, chunk]);
    this.consume();
  }

  /**
   * 结束输入并检查未完成 record；无输出时返回，partial header/payload 必须报告 status 而非静默丢弃。
   * 回归：tests/logcat-parser.test.js 的 EOF partial frame 断言错误可见。
   */
  end(): void {
    if (this.failed) return;
    if (this.pending.length) this.fail('Logcat binary stream ended with truncated frame');
  }

  /** 按 len/hdr_size 消费 pending；完整帧输出记录，不完整帧保留；tests/logcat-parser.test.js 逐字节/批次/版本头断言边界和顺序。 */
  private consume(): void {
    while (!this.failed) {
      if (this.pending.length < 4) return;
      const len = this.pending.readUInt16LE(0);
      const hdrSize = this.pending.readUInt16LE(2) || 20;
      if (!HEADER_SIZES.has(hdrSize)) { this.fail('Logcat binary frame has unsupported header size: ' + hdrSize); return; }
      if (len < 3) { this.fail('Logcat binary frame has invalid payload length: ' + len); return; }
      const total = hdrSize + len;
      if (this.pending.length < total) return;
      const frame = this.pending.subarray(0, total);
      this.pending = this.pending.subarray(total);
      const record = this.decode(frame, len, hdrSize);
      if (!record) return;
      this.onRecord(record);
    }
  }

  /** 解码完整 logger_entry，校验文本 buffer/priority/nsec/NUL；输出原字段或错误；tests/logcat-parser.test.js 覆盖 UTF8/空行/末尾换行和坏元数据。 */
  private decode(frame: Buffer, len: number, hdrSize: number): BinaryLogRecord | undefined {
    if (frame.length < hdrSize + len) { this.fail('Logcat binary frame is truncated'); return; }
    if (hdrSize === 28 && ![0, 3, 4].includes(frame.readUInt32LE(20))) { this.fail('Logcat binary frame has unsupported text buffer: ' + frame.readUInt32LE(20)); return; }
    const payload = frame.subarray(hdrSize, hdrSize + len);
    const firstNul = payload.indexOf(0, 1);
    if (firstNul < 0) { this.fail('Logcat binary frame has no NUL-terminated tag'); return; }
    const secondNul = payload.indexOf(0, firstNul + 1);
    if (secondNul < 0) { this.fail('Logcat binary frame has no NUL-terminated message'); return; }
    if (secondNul !== payload.length - 1) { this.fail('Logcat binary frame has bytes after terminated message'); return; }
    const priority = payload[0];
    if (priority < 2 || priority > 7) { this.fail('Logcat binary frame has invalid priority: ' + priority); return; }
    const nsec = frame.readInt32LE(16);
    if (nsec < 0 || nsec > 999999999) { this.fail('Logcat binary frame has invalid nanoseconds: ' + nsec); return; }
    return {
      pid: frame.readInt32LE(4), tid: frame.readInt32LE(8), sec: frame.readInt32LE(12), nsec,
      priority, tag: payload.subarray(1, firstNul).toString('utf8'), message: payload.subarray(firstNul + 1, secondNul).toString('utf8'),
    };
  }

  /** 坏帧不可安全重新对齐时释放 partial 并回调错误，调用方须停止流；parser malformed 与 visibility binary stream 回归断言诊断和 proc.kill。 */
  private fail(text: string): void {
    this.failed = true;
    this.pending = Buffer.alloc(0);
    this.onStatus(text);
  }
}
