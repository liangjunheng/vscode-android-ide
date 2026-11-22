package android.debugger.coordinator

import com.android.adblib.AdbSession
import com.android.adblib.AdbSessionHost
import com.android.adblib.ConnectedDevice
import com.android.adblib.DeviceSelector
import com.android.adblib.DeviceState
import com.android.adblib.EmptyAdbInputChannel
import com.android.adblib.connectedDevicesTracker
import com.android.adblib.deviceInfo
import com.android.adblib.isOnline
import com.android.adblib.serialNumber
import com.android.adblib.shellAsText
import com.android.adblib.tools.debugging.JdwpProcess
import com.android.adblib.tools.debugging.getOrNull
import com.android.adblib.tools.debugging.jdwpProcessTracker
import com.android.adblib.tools.debugging.jdwpProxySocketServer
import com.android.adblib.tools.debugging.propertiesFlow
import com.android.adblib.tools.debugging.packets.JdwpPacketView
import com.android.adblib.tools.debugging.sendAndReceiveCommand
import com.android.adblib.tools.install
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PrintStream
import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.util.Base64
import java.util.concurrent.Executors
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*

interface Backend : AutoCloseable {
  suspend fun devices(): List<DeviceSnapshot>
  suspend fun clients(serial: String): List<ClientSnapshot>
  fun events(): Flow<BackendEvent>
  suspend fun claim(serial: String, pid: Int): BackendLease
  suspend fun release(lease: BackendLease)
  suspend fun shell(serial: String, command: String): String
  suspend fun install(serial: String, apkPath: String)
  suspend fun launch(serial: String, packageName: String, component: String): Int
}

data class DeviceSnapshot(val serial: String, val state: String)
data class ClientSnapshot(val pid: Int, val packageName: String)
sealed interface BackendEvent {
  data class DeviceChanged(val serial: String) : BackendEvent
  data class DeviceLost(val serial: String) : BackendEvent
  data class ClientsChanged(val serial: String) : BackendEvent
}
interface BackendLease {
  val serial: String
  val pid: Int
  val port: Int
  val lost: Flow<Unit>
  suspend fun resume()
}

/** 单线程协程保存请求和租约，设备通信通过官方adblib挂起API执行。 */
class AndroidDebugCoordinator(private val backend: Backend, private val protocol: PrintStream) {
  private val requests = LinkedHashMap<String, Job>()
  private val requestDevices = LinkedHashMap<String, String>()
  private val leases = LinkedHashMap<String, BackendLease>()
  private val targets = LinkedHashMap<String, String>()
  private val watchers = LinkedHashMap<String, Job>()
  private val releasing = LinkedHashMap<String, Deferred<Unit>>()
  private lateinit var scope: CoroutineScope

  /** 功能：处理完整协议流并在EOF结算资源；输入请求Channel；输出响应与关闭结果；验证：AndroidDebugCoordinatorTest。 */
  suspend fun serve(lines: kotlinx.coroutines.channels.ReceiveChannel<String>) = supervisorScope {
    scope = this
    val events = launch { backend.events().collect { changed(it) } }
    try {
      for (line in lines) handle(line)
    } finally {
      withContext(NonCancellable) {
        events.cancelAndJoin()
        val pending = requests.values.toList()
        pending.forEach { it.cancel() }
        pending.joinAll()
        val failures = mutableListOf<Throwable>()
        for (id in leases.keys.toList()) {
          try { release(id) } catch (error: Throwable) { failures.add(error) }
        }
        watchers.values.toList().forEach { it.cancelAndJoin() }
        try { backend.close() } catch (error: Throwable) { failures.add(error) }
        if (failures.isNotEmpty()) throw IllegalStateException("Android Coordinator shutdown failed").also { failure -> failures.forEach(failure::addSuppressed) }
      }
    }
  }

  /** 功能：登记无固定期限且可取消的独立请求；输入原协议行；输出一次响应，设备失联结束所属等待；验证：CoordinatorCancellationTest及协议回归。 */
  private fun handle(line: String) {
    val fields = line.split('\t')
    val id = fields.firstOrNull().orEmpty()
    if (!id.matches(Regex("[1-9][0-9]*"))) { System.err.println("W: Invalid Coordinator request ID"); return }
    try {
      require(fields.size >= 2) { "Missing coordinator operation" }
      check(!requests.containsKey(id) && !leases.containsKey(id)) { "Duplicate coordinator request ID" }
      val operation = fields[1]
      val args = fields.drop(2).map { value ->
        require(value.matches(Regex("[A-Za-z0-9_-]*"))) { "Invalid Coordinator Base64URL payload" }
        String(Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8)
      }
      val job = scope.launch(start = CoroutineStart.LAZY) {
        try {
          val value = execute(id, operation, args)
          currentCoroutineContext().ensureActive()
          reply(id, "OK", value)
        } catch (error: Throwable) {
          if (leases.containsKey(id)) {
            try { withContext(NonCancellable) { release(id) } }
            catch (cleanup: Throwable) { error.addSuppressed(cleanup) }
          }
          System.err.println("W: Coordinator request $id $operation failed: $error")
          reply(id, "ERROR", error.toString() + error.suppressed.joinToString { "; cleanup: $it" })
        } finally { requests.remove(id); requestDevices.remove(id) }
      }
      requests[id] = job
      when (operation) {
        "clients", "claim", "install", "shell", "launch" -> args.firstOrNull()?.let { requestDevices[id] = it }
        "resume" -> args.firstOrNull()?.let { leases[it]?.serial }?.let { requestDevices[id] = it }
      }
      job.start()
    } catch (error: Throwable) { reply(id, "ERROR", error.toString()) }
  }

  /** 功能：派发官方设备操作及租约事务；输入请求ID、操作和参数；输出原协议载荷；验证：全部控制面单元及真机入口。 */
  private suspend fun execute(id: String, operation: String, args: List<String>): String {
    fun count(expected: Int) { require(args.size == expected) { "Expected $expected coordinator arguments" } }
    when (operation) {
      "devices" -> { count(0); return backend.devices().joinToString("\n") { "${it.serial}\t${it.state}" } }
      "clients" -> { count(1); return backend.clients(args[0]).joinToString("\n") { "${it.pid}\t${it.packageName}" } }
      "claim" -> {
        count(2)
        val pid = args[1].toIntOrNull()?.takeIf { it > 0 } ?: error("Invalid Android PID")
        val target = "${args[0]}\u0000$pid"
        check(!targets.containsKey(target)) { "Android process already has a debugger or lease: $pid" }
        targets[target] = id
        try {
          val lease = backend.claim(args[0], pid)
          leases[id] = lease
          currentCoroutineContext().ensureActive()
          watchers[id] = scope.launch {
            lease.lost.first()
            if (leases[id] === lease && !releasing.containsKey(id)) {
              leases.remove(id)
              targets.remove(target)
              watchers.remove(id)
              try { backend.release(lease) } catch (error: Throwable) { System.err.println("W: Lost JDWP lease cleanup failed: $error") }
              event("lease.lost", id)
            }
          }
          return "$id\t${lease.port}"
        } finally {
          if (!leases.containsKey(id)) targets.remove(target, id)
        }
      }
      "release", "cancel" -> {
        count(1)
        val targetId = args[0]
        require(targetId.matches(Regex("[1-9][0-9]*")) && targetId != id) { "Invalid coordinator lease/request ID" }
        requests[targetId]?.cancelAndJoin()
        release(targetId)
      }
      "resume" -> {
        count(1)
        val lease = leases[args[0]] ?: error("Unknown Android JDWP lease")
        lease.resume()
      }
      "shell" -> { count(2); return backend.shell(args[0], args[1]) }
      "install" -> { count(2); backend.install(args[0], args[1]) }
      "launch" -> { count(3); return backend.launch(args[0], args[1], args[2]).toString() }
      else -> error("Unknown coordinator operation: $operation")
    }
    return ""
  }

  /** 功能：共享同一租约清理并等待官方代理断开；输入精确租约ID；输出成功后移除索引，失败保留；验证：断开屏障与重复释放测试。 */
  private suspend fun release(id: String) {
    val lease = leases[id] ?: return
    val closing = releasing.getOrPut(id) {
      scope.async<Unit> {
        backend.release(lease)
        watchers.remove(id)?.cancelAndJoin()
        leases.remove(id, lease)
        targets.remove("${lease.serial}\u0000${lease.pid}", id)
      }
    }
    closing.await()
    releasing.remove(id, closing)
  }

  /** 功能：转发设备事件并取消失联设备的请求；输入官方后端事件；输出所属等待结束与通知；验证：CoordinatorCancellationTest及事件回归。 */
  private fun changed(change: BackendEvent) {
    when (change) {
      is BackendEvent.DeviceChanged -> event("device.changed", change.serial)
      is BackendEvent.DeviceLost -> {
        for ((id, serial) in requestDevices.toMap()) if (serial == change.serial) {
          requests[id]?.cancel(CancellationException("Android device disconnected: $serial"))
        }
        event("device.lost", change.serial)
      }
      is BackendEvent.ClientsChanged -> event("client.changed", change.serial)
    }
  }

  /** 功能：输出原协议响应；输入ID、状态和文本；输出完整编码行；验证：协议回归。 */
  private fun reply(id: String, status: String, value: String) { protocol.println("$id\t$status\t${encode(value)}") }
  /** 功能：输出原协议事件；输入事件名和归属值；输出完整编码行；验证：事件回归。 */
  private fun event(type: String, value: String) { protocol.println("0\tEVENT\t${encode(type)}\t${encode(value)}") }
  /** 功能：编码协议文本；输入UTF8值；输出无填充Base64URL；验证：协议回归。 */
  private fun encode(value: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(value.toByteArray(StandardCharsets.UTF_8))

  companion object {
    /** 功能：隔离日志与协议并连接共享ADB；输入标准流；输出可等待的控制面生命周期；验证：构建和真机宿主入口。 */
    @JvmStatic fun main(args: Array<String>) {
      val protocol = PrintStream(System.out, true, StandardCharsets.UTF_8)
      System.setOut(System.err)
      val dispatcher = Executors.newSingleThreadExecutor { Thread(it, "android-coordinator-state") }.asCoroutineDispatcher()
      val host = AdbSessionHost()
      val session = AdbSession.create(host)
      try {
        runBlocking(dispatcher) {
          val lines = Channel<String>(Channel.UNLIMITED)
          val reader = launch(Dispatchers.IO) {
            try {
              val input = BufferedReader(InputStreamReader(System.`in`, StandardCharsets.UTF_8))
              while (true) lines.send(input.readLine() ?: break)
            } finally { lines.close() }
          }
          try { AndroidDebugCoordinator(AdblibBackend(session), protocol).serve(lines) }
          finally { reader.cancelAndJoin() }
        }
      } finally { session.close(); host.close(); dispatcher.close() }
    }
  }
}

/** 官方设备进程流和JDWP代理是唯一控制面，不依赖ddmlib Client重建。 */
class AdblibBackend(private val session: AdbSession) : Backend {
  private val tracker = session.connectedDevicesTracker

  /** 功能：等待首次设备快照；输入无；输出标准ADB状态，流错误立即失败；验证：宿主及设备状态回归。 */
  override suspend fun devices(): List<DeviceSnapshot> {
    val list = tracker.connectedDevices.first { !it.flowStatus.isStartOfFlow }
    check(list.flowStatus.isActive) { "Android device tracking failed: ${list.flowStatus}" }
    return list.map { DeviceSnapshot(it.serialNumber, if (it.isOnline) "device" else it.deviceInfo.deviceState.name.lowercase()) }
  }

  /** 功能：等待设备初始同步并校验在线身份；输入serial；输出当前官方设备对象；验证：设备状态回归。 */
  private suspend fun onlineDevice(serial: String): ConnectedDevice {
    devices()
    return tracker.connectedDevices.value.singleOrNull { it.serialNumber == serial && it.isOnline }
      ?: error("Android device is not connected: $serial")
  }

  /** 功能：读取已完成同步的进程列表；输入设备；输出官方进程身份；验证：同PID重附加真机入口。 */
  private suspend fun processes(device: ConnectedDevice): List<JdwpProcess> {
    val list = device.jdwpProcessTracker.processesFlow.first { !it.flowStatus.isStartOfFlow }
    check(list.flowStatus.isActive) { "Android process tracking failed: ${list.flowStatus}" }
    return list.toList()
  }

  /** 功能：读取进程包名属性；输入serial；输出官方PID与包名，不自行建立JDWP连接；验证：进程选择及真机入口。 */
  override suspend fun clients(serial: String): List<ClientSnapshot> = coroutineScope {
    processes(onlineDevice(serial)).map { process -> async {
      val properties = process.propertiesFlow.first { !it.packageName.isEmpty || !it.processName.isEmpty }
      ClientSnapshot(process.pid, properties.packageName.getOrNull().orEmpty())
    } }.awaitAll()
  }

  /** 功能：跟随设备身份创建事件观察并在移除时取消；输入设备与进程流；输出设备/进程变化；验证：失联及EOF回归。 */
  override fun events(): Flow<BackendEvent> = channelFlow {
    val known = LinkedHashMap<String, Pair<ConnectedDevice, Job>>()
    try {
      tracker.connectedDevices.collect { list ->
        val current = list.associateBy { it.serialNumber }
        for ((serial, entry) in known.toMap()) if (current[serial] !== entry.first) {
          entry.second.cancelAndJoin(); known.remove(serial); send(BackendEvent.DeviceLost(serial))
        }
        for ((serial, device) in current) if (!known.containsKey(serial)) {
          val observer = launch {
            launch { device.deviceInfoFlow.collect { info ->
              send(if (info.deviceState == DeviceState.ONLINE) BackendEvent.DeviceChanged(serial) else BackendEvent.DeviceLost(serial))
            } }
            launch { device.jdwpProcessTracker.processesFlow.collect { send(BackendEvent.ClientsChanged(serial)) } }
          }
          known[serial] = device to observer
        }
      }
    } finally { known.values.forEach { it.second.cancel() } }
  }

  /** 功能：等待指定PID官方代理真正监听；输入serial和PID；输出真实进程身份租约，已有外部连接拒绝；验证：重附加及独占回归。 */
  override suspend fun claim(serial: String, pid: Int): BackendLease {
    val device = onlineDevice(serial)
    val list = device.jdwpProcessTracker.processesFlow.first { values ->
      check(values.flowStatus.isStartOfFlow || values.flowStatus.isActive) { "Android process tracking failed: ${values.flowStatus}" }
      values.any { it.pid == pid }
    }
    val process = list.single { it.pid == pid }
    val status = process.jdwpProxySocketServer.proxyStatusFlow
    val monitor = session.scope.launch { status.collect() }
    try {
      val ready = status.first { !it.socketAddress.isEmpty }
      check(!ready.socketAddress.isError) { ready.socketAddress.getErrorMessageOrThrow() }
      check(!ready.isExternalDebuggerAttached) { "Android process already has a debugger: $pid" }
      return AdblibLease(process, monitor, ready.socketAddress.getOrThrow().port)
    } catch (error: Throwable) { monitor.cancelAndJoin(); throw error }
  }

  /** 功能：等待代理结束后关闭租约观察；输入官方租约；输出真实断开完成，进程失联直接结束；验证：断开屏障及同PID重附加。 */
  override suspend fun release(lease: BackendLease) { (lease as AdblibLease).close() }

  /** 功能：执行官方ShellV2并检查退出码；输入serial和命令；输出stdout或实际错误；验证：shell错误和真机入口。 */
  override suspend fun shell(serial: String, command: String): String {
    onlineDevice(serial)
    val output = session.deviceServices.shellAsText(DeviceSelector.fromSerialNumber(serial), command)
    check(output.exitCode == 0) { "Android shell exited ${output.exitCode}: ${output.stderr.ifEmpty { output.stdout }}" }
    return output.stdout
  }

  /** 功能：安装APK保留替换语义；输入serial和本机路径；输出官方安装完成；验证：安装错误与六组合真机入口。 */
  override suspend fun install(serial: String, apkPath: String) {
    onlineDevice(serial)
    session.deviceServices.install(DeviceSelector.fromSerialNumber(serial), listOf(Path.of(apkPath)), listOf("-r"))
  }

  /** 功能：启动一次应用并交叉确认新进程的系统身份与JDWP登记；输入合法包名及组件；输出唯一新PID；验证：LaunchProcessTest及coordinator-launch-after-attach-device.test.js。 */
  override suspend fun launch(serial: String, packageName: String, component: String): Int {
    require(packageName.matches(Regex("[A-Za-z_][\\w]*(?:\\.[A-Za-z_][\\w]*)+"))) { "Invalid Android package name" }
    val device = onlineDevice(serial)
    val selected = if (component.isEmpty()) shell(serial, "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER $packageName")
      .lineSequence().map(String::trim).firstOrNull { it.startsWith("$packageName/") }
      ?: error("Unable to resolve launcher activity for $packageName") else component
    require(selected.matches(Regex("[\\w.$]+/[\\w.$]+"))) { "Invalid Android launch component" }
    val previous = processes(device)
    shell(serial, "am force-stop $packageName && am start -D -n '$selected'")
    return awaitLaunchedProcess(device.jdwpProcessTracker.processesFlow.map { list ->
      check(list.flowStatus.isStartOfFlow || list.flowStatus.isActive) { "Android process tracking failed: ${list.flowStatus}" }
      list.toList()
    }, previous, JdwpProcess::pid) {
      launchedProcessIds(shell(serial, "ps -A -o PID,ARGS"), packageName)
    }
  }

  /** 功能：关闭控制面会话；输入无；输出官方资源释放；验证：EOF回归。 */
  override fun close() { session.close() }
}

private class AdblibLease(private val process: JdwpProcess, private val monitor: Job, override val port: Int) : BackendLease {
  override val serial = process.device.serialNumber
  override val pid = process.pid
  override val lost: Flow<Unit> = flow { process.scope.coroutineContext[Job]!!.join(); emit(Unit) }

  /** 功能：通过同一共享JDWP发送唯一VM.Resume并等回复；输入无；输出恢复完成或协议错误；验证：Native Launch真机入口。 */
  override suspend fun resume() {
    process.withJdwpSession {
      val reply = sendAndReceiveCommand(JdwpPacketView.Command(nextPacketId(), 11, 1, 9, EmptyAdbInputChannel()))
      check(reply.errorCode == 0) { "JDWP VM.Resume failed: ${reply.errorCode}" }
    }
  }

  /** 功能：等待官方代理完成解绑再撤观察；输入无；输出不触发Client重建的释放屏障；验证：同PID三轮真机入口。 */
  suspend fun close() {
    if (process.scope.isActive) process.jdwpProxySocketServer.proxyStatusFlow.first { status ->
      check(!status.socketAddress.isError) { status.socketAddress.getErrorMessageOrThrow() }
      !status.isExternalDebuggerAttached
    }
    monitor.cancelAndJoin()
  }
}
