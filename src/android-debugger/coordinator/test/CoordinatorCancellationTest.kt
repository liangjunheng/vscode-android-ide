package android.debugger.coordinator

import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.nio.charset.StandardCharsets
import java.util.Base64
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/**
 * 功能点：无固定期限的控制面请求与显式取消。
 * 受影响对象：Coordinator请求、设备失联、EOF和租约释放。
 * 复现路径：虚拟时间超过30秒，分别完成、取消、断开设备和关闭输入。
 * 测试范围：长期Launch、长期释放、用户取消、设备隔离及EOF收敛。
 * 执行入口：npm run build:jvm中的Coordinator Maven test。
 * 预期结果：超过30秒不自动失败，生命周期事件可靠结束所属等待。
 * 判据：虚拟时间与真实协议响应全部一致，不使用真实sleep。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CoordinatorCancellationTest {
  /** 功能：验证Launch等待不受30秒截止；输入虚拟60秒及后端完成；输出成功PID；验证：本测试。 */
  @Test fun launchCanCompleteAfterThirtySeconds() = runTest {
    val f = Fixture(this)
    f.send("1", "launch", "S", "com.example.app", "com.example.app/Main")
    runCurrent(); advanceTimeBy(60_000); runCurrent()
    assertFalse(f.responses.containsKey("1"))
    f.backend.complete.complete(Unit); runCurrent()
    assertEquals("OK" to "43", f.responses["1"])
    f.close()
  }

  /** 功能：验证显式取消长期Launch；输入取消请求；输出目标取消错误及ACK；验证：本测试。 */
  @Test fun userCancellationEndsThePendingLaunch() = runTest {
    val f = Fixture(this)
    f.send("1", "launch", "S", "com.example.app", "com.example.app/Main"); runCurrent()
    advanceTimeBy(60_000); f.send("2", "cancel", "1"); runCurrent()
    assertEquals("ERROR", f.responses["1"]?.first)
    assertTrue(f.responses["1"]!!.second.contains("cancel", ignoreCase = true))
    assertEquals("OK" to "", f.responses["2"])
    f.close()
  }

  /** 功能：验证设备失联仅取消所属请求；输入其他设备及目标设备失联；输出目标错误；验证：本测试。 */
  @Test fun deviceLossCancelsOnlyItsOwnLaunch() = runTest {
    val f = Fixture(this)
    f.send("1", "launch", "S", "com.example.app", "com.example.app/Main"); runCurrent()
    f.backend.changes.send(BackendEvent.DeviceLost("T")); runCurrent()
    assertFalse(f.responses.containsKey("1"))
    f.backend.changes.send(BackendEvent.DeviceLost("S")); runCurrent()
    assertEquals("ERROR", f.responses["1"]?.first)
    assertTrue(f.responses["1"]!!.second.contains("disconnected"))
    f.close()
  }

  /** 功能：验证EOF取消未完成Launch；输入关闭的请求通道；输出请求退出并关闭后端；验证：本测试。 */
  @Test fun eofCancelsPendingLaunchWithoutDeadline() = runTest {
    val f = Fixture(this)
    f.send("1", "launch", "S", "com.example.app", "com.example.app/Main"); runCurrent()
    f.close()
    assertEquals("ERROR", f.responses["1"]?.first)
    assertTrue(f.backend.closed)
  }

  /** 功能：验证租约释放也不受固定截止；输入虚拟60秒后完成detach；输出释放成功；验证：本测试。 */
  @Test fun detachCanCompleteAfterThirtySeconds() = runTest {
    val f = Fixture(this)
    f.send("1", "claim", "S", "43"); runCurrent()
    f.send("2", "release", "1"); runCurrent()
    advanceTimeBy(60_000); runCurrent(); assertFalse(f.responses.containsKey("2"))
    f.backend.detach.complete(Unit); runCurrent()
    assertEquals("OK" to "", f.responses["2"])
    f.close()
  }

  private class Fixture(scope: CoroutineScope) {
    val backend = ControlledBackend()
    val responses = mutableMapOf<String, Pair<String, String>>()
    private val lines = Channel<String>(Channel.UNLIMITED)
    private val protocol = object : PrintStream(ByteArrayOutputStream(), true, StandardCharsets.UTF_8) {
      override fun println(text: String) {
        val fields = text.split('\t')
        if (fields[0] != "0") responses[fields[0]] = fields[1] to String(Base64.getUrlDecoder().decode(fields[2]), StandardCharsets.UTF_8)
      }
    }
    private val service = scope.async { AndroidDebugCoordinator(backend, protocol).serve(lines) }
    suspend fun send(id: String, operation: String, vararg args: String) {
      lines.send((listOf(id, operation) + args.map { Base64.getUrlEncoder().withoutPadding().encodeToString(it.toByteArray(StandardCharsets.UTF_8)) }).joinToString("\t"))
    }
    suspend fun close() { lines.close(); service.await() }
  }

  private class ControlledBackend : Backend {
    val complete = CompletableDeferred<Unit>()
    val detach = CompletableDeferred<Unit>()
    val changes = Channel<BackendEvent>(Channel.UNLIMITED)
    var closed = false
    override suspend fun devices() = emptyList<DeviceSnapshot>()
    override suspend fun clients(serial: String) = emptyList<ClientSnapshot>()
    override fun events() = changes.receiveAsFlow()
    override suspend fun claim(serial: String, pid: Int) = object : BackendLease {
      override val serial = serial
      override val pid = pid
      override val port = 8700
      override val lost: Flow<Unit> = flow { awaitCancellation() }
      override suspend fun resume() = Unit
    }
    override suspend fun release(lease: BackendLease) { detach.await() }
    override suspend fun shell(serial: String, command: String) = ""
    override suspend fun install(serial: String, apkPath: String) = Unit
    override suspend fun launch(serial: String, packageName: String, component: String): Int { complete.await(); return 43 }
    override fun close() { closed = true }
  }
}
