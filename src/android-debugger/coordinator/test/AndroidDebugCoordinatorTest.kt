package android.debugger.coordinator

import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.nio.charset.StandardCharsets
import java.util.Base64
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/**
 * 功能点：官方控制面协议与同PID租约生命周期。
 * 受影响对象：AndroidDebugCoordinator、Backend、取消与释放屏障。
 * 复现路径：JDK17，真实协议输入Channel与FakeBackend，不操作设备。
 * 测试范围：三轮同PID、独占、真实detach等待、迟到claim取消、命令错误、失联与EOF。
 * 执行入口：npm run build:jvm，执行Coordinator Maven test。
 * 预期结果：按请求ID一次响应，取消ACK在回收之后，正常detach不丢进程身份。
 * 判据：全部协议响应、顺序与资源断言通过；本机模拟不替代真机验收。
 */
class AndroidDebugCoordinatorTest {
  /** 功能：覆盖三轮同PID租约与精确解绑；输入FakeBackend的attached门闩；输出每轮完整回收；验证：本测试。 */
  @Test fun repeatedAttachWaitsForDetachAndPreservesProcess() = runBlocking {
    fixture {
      for (round in 1..3) {
        val claim = send("claim", "S", "42")
        assertEquals("$claim\t8700", response(claim))
        val duplicate = send("claim", "S", "42")
        assertTrue(response(duplicate, "ERROR").contains("already"))
        backend.lease.attached.value = true
        backend.releaseEntered = CompletableDeferred()
        val release = send("release", claim)
        backend.releaseEntered!!.await()
        assertFalse(replies.containsKey(release))
        backend.lease.attached.value = false
        assertEquals("", response(release))
        assertEquals(round, backend.releaseCount)
      }
      assertFalse(events.any { it.first == "lease.lost" })
    }
  }

  /** 功能：覆盖取消迟到claim的资源屏障；输入不可取消的设备完成门闩；输出先归还租约再ACK；验证：本测试。 */
  @Test fun cancelWaitsForLateClaimCleanup() = runBlocking {
    fixture {
      backend.claimGate = CompletableDeferred()
      backend.claimEntered = CompletableDeferred()
      val claim = send("claim", "S", "42")
      backend.claimEntered!!.await()
      val cancel = send("cancel", claim)
      yield()
      assertFalse(replies.containsKey(cancel))
      backend.claimGate!!.complete(Unit)
      assertTrue(response(claim, "ERROR").contains("cancel"))
      assertEquals("", response(cancel))
      assertEquals(1, backend.releaseCount)
    }
  }

  /** 功能：覆盖claim完成与取消同批输入；输入先完成claim再cancel；输出仍精确释放已交付租约；验证：本测试。 */
  @Test fun cancelAfterClaimResponseStillReleasesLease() = runBlocking {
    fixture {
      val claim = send("claim", "S", "42"); response(claim)
      response(send("cancel", claim))
      assertEquals(1, backend.releaseCount)
      response(send("claim", "S", "42"))
    }
  }

  /** 功能：覆盖错误传播及恢复；输入shell/install/resume失败；输出请求失败但控制面仍可查询；验证：本测试。 */
  @Test fun errorsRemainVisibleWithoutEndingProtocol() = runBlocking {
    fixture {
      assertEquals("S\tdevice", response(send("devices")))
      assertEquals("42\tcom.example.app", response(send("clients", "S")))
      assertTrue(response(send("claim", "S", "-1"), "ERROR").contains("PID"))
      assertTrue(response(send("native-start", "S"), "ERROR").contains("Unknown"))
      backend.commandFailure = IllegalStateException("device denied")
      assertTrue(response(send("shell", "S", "id"), "ERROR").contains("device denied"))
      assertTrue(response(send("install", "S", "fixture.apk"), "ERROR").contains("device denied"))
      backend.commandFailure = null
      val claim = send("claim", "S", "42"); response(claim)
      response(send("resume", claim)); assertEquals(1, backend.lease.resumeCount)
      response(send("release", claim))
    }
  }

  /** 功能：覆盖进程失联与精确清理；输入租约lost事件；输出一次所属lease.lost；验证：本测试。 */
  @Test fun processLossAffectsOnlyItsLease() = runBlocking {
    fixture {
      val claim = send("claim", "S", "42"); response(claim)
      backend.lease.loss.send(Unit)
      withTimeout(5000) { while (events.none { it == ("lease.lost" to claim) }) eventSignal.receive() }
      assertEquals(1, events.count { it == ("lease.lost" to claim) })
      response(send("release", claim)); assertEquals(1, backend.releaseCount)
    }
  }

  /** 功能：覆盖EOF资源归还顺序；输入已交付租约及输入关闭；输出先release后backend.close；验证：本测试。 */
  @Test fun eofReturnsLeaseBeforeClosingBackend() = runBlocking {
    val backend = FakeBackend()
    fixture(backend) { response(send("claim", "S", "42")) }
    assertEquals(listOf("release", "close"), backend.order)
  }

  /** 功能：覆盖释放错误保留租约并阻止后续同PID；输入失败的后端释放；输出明确ERROR而非伪成功；验证：本测试。 */
  @Test fun failedReleaseDoesNotPublishAnAvailableTarget() = runBlocking {
    val backend = FakeBackend()
    backend.releaseFailure = IllegalStateException("detach failed")
    val failure = assertThrows(IllegalStateException::class.java) {
      runBlocking { fixture(backend) {
        val claim = send("claim", "S", "42"); response(claim)
        assertTrue(response(send("release", claim), "ERROR").contains("detach failed"))
        assertTrue(response(send("claim", "S", "42"), "ERROR").contains("already"))
      } }
    }
    assertTrue(failure.message!!.contains("shutdown failed"))
  }

  /** 功能：运行真实协议与可控后端；输入测试体；输出始终关闭Channel并等待服务结束；验证：本文件全部用例。 */
  private suspend fun fixture(backend: FakeBackend = FakeBackend(), block: suspend Fixture.() -> Unit) = coroutineScope {
    val f = Fixture(backend)
    val service = async { AndroidDebugCoordinator(backend, f.protocol).serve(f.lines) }
    try { withTimeout(5000) { f.block() } } finally { f.lines.close(); service.await() }
  }
}

private class Fixture(val backend: FakeBackend) {
  val lines = Channel<String>(Channel.UNLIMITED)
  val replies = LinkedHashMap<String, Pair<String, String>>()
  val events = mutableListOf<Pair<String, String>>()
  val eventSignal = Channel<Unit>(Channel.UNLIMITED)
  private val signal = Channel<Unit>(Channel.UNLIMITED)
  private var sequence = 0
  val protocol = object : PrintStream(ByteArrayOutputStream(), true, StandardCharsets.UTF_8) {
    override fun println(text: String) {
      val parts = text.split('\t')
      fun decode(value: String) = String(Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8)
      if (parts[0] == "0") { events.add(decode(parts[2]) to decode(parts[3])); eventSignal.trySend(Unit) }
      else { replies[parts[0]] = parts[1] to decode(parts[2]); signal.trySend(Unit) }
    }
  }

  /** 功能：写入真实编码请求；输入操作参数；输出唯一请求ID；验证：本文件协议测试。 */
  suspend fun send(operation: String, vararg args: String): String {
    val id = (++sequence).toString()
    lines.send((listOf(id, operation) + args.map { Base64.getUrlEncoder().withoutPadding().encodeToString(it.toByteArray(StandardCharsets.UTF_8)) }).joinToString("\t"))
    return id
  }
  /** 功能：等待指定请求真实响应；输入ID和预期状态；输出载荷；验证：本文件全部协议断言。 */
  suspend fun response(id: String, status: String = "OK"): String {
    while (!replies.containsKey(id)) signal.receive()
    val result = replies.getValue(id)
    assertEquals(status, result.first, result.second)
    return result.second
  }
}

private class FakeBackend : Backend {
  val lease = FakeLease()
  var claimGate: CompletableDeferred<Unit>? = null
  var claimEntered: CompletableDeferred<Unit>? = null
  var releaseEntered: CompletableDeferred<Unit>? = null
  var releaseCount = 0
  var commandFailure: Throwable? = null
  var releaseFailure: Throwable? = null
  val order = mutableListOf<String>()
  override suspend fun devices() = listOf(DeviceSnapshot("S", "device"))
  override suspend fun clients(serial: String) = listOf(ClientSnapshot(42, "com.example.app"))
  override fun events(): Flow<BackendEvent> = emptyFlow()
  override suspend fun claim(serial: String, pid: Int): BackendLease {
    claimEntered?.complete(Unit)
    withContext(NonCancellable) { claimGate?.await() }
    return lease
  }
  override suspend fun release(lease: BackendLease) {
    releaseEntered?.complete(Unit)
    (lease as FakeLease).attached.first { !it }
    releaseFailure?.let { throw it }
    releaseCount++; order.add("release")
  }
  override suspend fun shell(serial: String, command: String): String { commandFailure?.let { throw it }; return "shell" }
  override suspend fun install(serial: String, apkPath: String) { commandFailure?.let { throw it } }
  override suspend fun launch(serial: String, packageName: String, component: String) = 42
  override fun close() { order.add("close") }
}
private class FakeLease : BackendLease {
  override val serial = "S"
  override val pid = 42
  override val port = 8700
  val attached = MutableStateFlow(false)
  val loss = Channel<Unit>(Channel.UNLIMITED)
  override val lost: Flow<Unit> = loss.receiveAsFlow()
  var resumeCount = 0
  override suspend fun resume() { resumeCount++ }
}
