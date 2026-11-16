(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.LogcatBuffer = factory(); }
})(this, function () {
  // 计算 UTF-8 字节数；输入为日志文本，输出用于内存上限计算的字节数。
  const utf8Bytes = (text) => new TextEncoder().encode(String(text)).byteLength;

  // 将单条消息截断到上限；输入为文本和字节上限，输出不会超过上限的可显示文本。
  const truncateUtf8 = (text, maxBytes) => {
    const value = String(text);
    const bytes = new TextEncoder().encode(value);
    return bytes.byteLength <= maxBytes ? value : new TextDecoder().decode(bytes.slice(0, maxBytes), { stream: true });
  };

  // 从队列头部淘汰旧项；输入为数组、字节上限和计量函数，输出为淘汰后的总字节数。
  const trimOldest = (items, maxBytes, sizeOf) => {
    let total = items.reduce((sum, item) => sum + sizeOf(item), 0);
    while (total > maxBytes && items.length) { total -= sizeOf(items.shift()); }
    return total;
  };

  return { utf8Bytes, truncateUtf8, trimOldest };
});
