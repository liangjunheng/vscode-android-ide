package android.debugger.coordinator

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** 功能：交叉确认本次启动的唯一新JDWP进程；输入事件快照、旧对象、PID读取器和系统身份查询；输出新PID，不读取DDMS属性；验证：LaunchProcessTest及真实Attach后Launch入口。 */
internal suspend fun <T : Any> awaitLaunchedProcess(
  snapshots: Flow<List<T>>,
  previous: List<T>,
  pid: (T) -> Int,
  systemPids: suspend () -> Set<Int>,
): Int = snapshots.map { processes ->
  val candidates = systemPids()
  check(candidates.size <= 1) { "Expected exactly one launched Android process: $candidates" }
  processes.filter { process -> pid(process) in candidates && previous.none { it === process } }
}.first { it.isNotEmpty() }.single().let(pid)

/** 功能：解析系统进程表并按完整进程名定位主进程；输入ps PID/ARGS输出及已验证包名；输出候选PID集合，非法表立即拒绝；验证：LaunchProcessTest。 */
internal fun launchedProcessIds(output: String, processName: String): Set<Int> {
  val lines = output.lineSequence().map(String::trim).filter(String::isNotEmpty).toList()
  check(lines.firstOrNull()?.split(Regex("\\s+")) == listOf("PID", "ARGS")) { "Invalid Android process table header" }
  return lines.drop(1).mapNotNull { row ->
    val fields = row.split(Regex("\\s+"), limit = 2)
    val pid = fields[0].toIntOrNull()?.takeIf { it > 0 } ?: error("Invalid Android process table PID")
    if (fields.getOrNull(1) == processName) pid else null
  }.toSet()
}
