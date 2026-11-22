package android.debugger.coordinator

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/**
 * 功能点：Launch新目标的系统身份与JDWP事件交叉确认。
 * 受影响对象：awaitLaunchedProcess、AdblibBackend.launch；不改变Attach租约。
 * 复现路径：旧Attach目标仍在快照，Launch产生新目标，DDMS属性始终不可用。
 * 测试范围：旧对象排除、PID复用、晚到事件、无关进程、歧义与取消。
 * 执行入口：npm run build:jvm；真实设备入口coordinator-launch-after-attach-device.test.js。
 * 预期结果：仅返回系统身份确认且不是旧对象的新JDWP进程，不读取任何进程元数据。
 * 判据：全部确定性Flow断言通过，取消/歧义显式失败，无sleep或重试。
 */
class LaunchProcessTest {
  private class Process(val pid: Int)

  /** 功能：覆盖完整进程名匹配与表格式边界；输入主进程、子进程、相似包名和命令参数；输出仅精确目标PID；验证：本测试。 */
  @Test fun processTableMatchesOnlyTheExactProcessIdentity() {
    val table = "PID ARGS\r\n 42 com.example.app\r\n43 com.example.app:worker\r\n44 com.example.application\r\n45 tool com.example.app\r\n"
    assertEquals(setOf(42), launchedProcessIds(table, "com.example.app"))
    assertEquals(emptySet<Int>(), launchedProcessIds("PID ARGS\n42 unrelated\n", "com.example.app"))
    assertThrows(IllegalStateException::class.java) { launchedProcessIds("unexpected", "com.example.app") }
    assertThrows(IllegalStateException::class.java) { launchedProcessIds("PID ARGS\ninvalid com.example.app", "com.example.app") }
  }

  /** 功能：重现旧目标残留及新目标晚到；输入系统身份与事件快照；输出只返回新PID；验证：本测试。 */
  @Test fun ignoresOldAndUnrelatedProcessesWithoutMetadata() = runBlocking {
    val old = Process(42)
    val foreign = Process(17)
    val next = Process(43)
    var system = setOf(42)
    var queries = 0
    val snapshots = MutableSharedFlow<List<Process>>()
    val result = async(start = CoroutineStart.UNDISPATCHED) {
      awaitLaunchedProcess(snapshots, listOf(old, foreign), Process::pid) { queries++; system }
    }
    snapshots.emit(listOf(old, foreign)); yield(); assertFalse(result.isCompleted)
    system = setOf(43)
    snapshots.emit(listOf(foreign)); yield(); assertFalse(result.isCompleted)
    snapshots.emit(listOf(foreign, next))
    assertEquals(43, result.await()); assertEquals(3, queries)
  }

  /** 功能：以对象身份排除旧进程而允许PID复用；输入同PID的新对象；输出新对象PID；验证：本测试。 */
  @Test fun reusedPidRequiresNewTrackedIdentity() = runBlocking {
    val old = Process(42)
    assertEquals(42, awaitLaunchedProcess(flowOf(listOf(old), listOf(Process(42))), listOf(old), Process::pid) { setOf(42) })
  }

  /** 功能：等待JDWP登记且不选其他进程；输入系统已定位但JDWP未就绪快照；输出登记后PID；验证：本测试。 */
  @Test fun waitsForBothSourcesToAgree() = runBlocking {
    val next = Process(43)
    assertEquals(43, awaitLaunchedProcess(flowOf(emptyList(), listOf(Process(99)), listOf(next)), emptyList(), Process::pid) { setOf(43) })
  }

  /** 功能：拒绝歧义系统身份；输入多个同名PID；输出明确错误；验证：本测试。 */
  @Test fun ambiguousSystemIdentityFailsInsteadOfSelectingFirst() {
    val error = assertThrows(IllegalStateException::class.java) {
      runBlocking { awaitLaunchedProcess(flowOf(listOf(Process(43), Process(44))), emptyList(), Process::pid) { setOf(43, 44) } }
    }
    assertTrue(error.message!!.contains("exactly one"))
  }

  /** 功能：保留系统身份查询失败；输入失败的设备查询；输出实际错误，不伪装成等待目标；验证：本测试。 */
  @Test fun systemIdentityFailureIsNotTreatedAsMissingProcess() {
    val error = assertThrows(IllegalStateException::class.java) {
      runBlocking { awaitLaunchedProcess(flowOf(listOf(Process(43))), emptyList(), Process::pid) { error("device offline") } }
    }
    assertEquals("device offline", error.message)
  }

  /** 功能：取消未完成启动观察；输入永不就绪快照；输出观察结束不产生PID；验证：本测试。 */
  @Test fun cancellationStopsPendingLaunchObservation() = runBlocking {
    val result = async(start = CoroutineStart.UNDISPATCHED) {
      awaitLaunchedProcess(MutableStateFlow(emptyList<Process>()), emptyList(), Process::pid) { emptySet() }
    }
    assertFalse(result.isCompleted)
    result.cancelAndJoin(); assertTrue(result.isCancelled)
  }
}
