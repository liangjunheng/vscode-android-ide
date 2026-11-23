package dev.ktdebug

import com.sun.jdi.VirtualMachine
import com.sun.jdi.event.EventSet
import com.sun.jdi.event.VMStartEvent
import com.sun.jdi.request.EventRequest
import dev.ktdebug.session.DebugEvents
import dev.ktdebug.session.DebugSession
import dev.ktdebug.session.SessionConfig
import dev.ktdebug.session.SourceIndex
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.lang.reflect.Proxy
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

// 功能点：VMStart 与 configurationDone 的跨线程恢复交接；受影响对象：DebugSession 的启动挂起。
// 复现路径：代理 JDI 事件集，两线程同屏障竞争；正常路径分别先配置、先事件及不挂起。
// 测试范围：双向先后、并发交接及重复配置；执行入口：Maven -Dtest=StartResumeTest test。
// 预期结果：每个挂起事件恰好恢复一次；判据：无漏恢复、重复恢复或超时，不操作设备。
class StartResumeTest {
    /** 功能：创建无设备接口代理；输入接口及方法处理；输出仅用于本文件的 JDI 边界。 */
    private inline fun <reified T> proxy(crossinline body: (String) -> Any?): T =
        Proxy.newProxyInstance(T::class.java.classLoader, arrayOf(T::class.java)) { _, method, _ -> body(method.name) } as T

    /** 功能：生成真实会话和可计数启动事件；输入挂起策略；输出事件处理入口与恢复次数。 */
    private fun fixture(policy: Int): Triple<DebugSession, () -> Unit, AtomicInteger> {
        val resumes = AtomicInteger()
        val vm = proxy<VirtualMachine> { null }
        val events = proxy<DebugEvents> { null }
        val event = proxy<VMStartEvent> { null }
        val set = proxy<EventSet> { name ->
            when (name) {
                "suspendPolicy" -> policy
                "resume" -> { resumes.incrementAndGet(); null }
                else -> null
            }
        }
        val session = DebugSession(vm, SessionConfig.from("attach", emptyMap()), SourceIndex(emptyList()), events)
        val handle = DebugSession::class.java.getDeclaredMethod("handleEvent", com.sun.jdi.event.Event::class.java, EventSet::class.java).apply { isAccessible = true }
        return Triple(session, {
            val outcome = handle.invoke(session, event, set)
            if (outcome.javaClass.simpleName == "Resume") set.resume()
        }, resumes)
    }

    @Test
    fun `both serial orders resume exactly once`() {
        for (configuredFirst in listOf(false, true)) {
            val (session, start, resumes) = fixture(EventRequest.SUSPEND_ALL)
            if (configuredFirst) session.configurationDone()
            start()
            session.configurationDone()
            session.configurationDone()
            assertEquals(1, resumes.get())
        }
    }

    @Test
    fun `non suspending event is not held`() {
        val (session, start, resumes) = fixture(EventRequest.SUSPEND_NONE)
        start()
        session.configurationDone()
        assertEquals(1, resumes.get())
    }

    @Test
    fun `concurrent start and configuration never lose resume`() {
        val executor = Executors.newFixedThreadPool(2)
        try {
            repeat(20000) { iteration ->
                val (session, start, resumes) = fixture(EventRequest.SUSPEND_ALL)
                val barrier = CyclicBarrier(2)
                val configured = executor.submit { barrier.await(); session.configurationDone() }
                val started = executor.submit { barrier.await(); start() }
                configured.get(5, TimeUnit.SECONDS)
                started.get(5, TimeUnit.SECONDS)
                assertEquals(1, resumes.get(), "启动恢复丢失，轮次 $iteration")
            }
        } finally {
            executor.shutdownNow()
            executor.awaitTermination(5, TimeUnit.SECONDS)
        }
    }
}
