package android.tools.gradle;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.TreeSet;
import java.util.LinkedHashMap;
import java.util.Base64;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.gradle.tooling.CancellationTokenSource;
import org.gradle.tooling.GradleConnector;
import org.gradle.tooling.ProjectConnection;
import org.gradle.tooling.model.GradleProject;
import org.gradle.tooling.model.GradleTask;

public final class GradleToolingServer {
    private final Map<String, ProjectConnection> connections = new LinkedHashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private CancellationTokenSource cancellation;
    private final PrintStream output;

    private GradleToolingServer(PrintStream output) { this.output = output; }

    // 启动独立协议服务，将Gradle日志与协议输出隔离；gradle-tooling.test.js实测查询与退出。
    public static void main(String[] args) throws Exception {
        PrintStream protocol = System.out;
        System.setOut(System.err);
        new GradleToolingServer(protocol).run();
    }

    // 主线程持续接受取消，工作线程独占模型连接；EOF取消查询并等待释放全部连接。
    private void run() throws Exception {
        try (BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = input.readLine()) != null) {
                if (line.equals("C")) { cancel(); continue; }
                if (!line.startsWith("Q\t")) throw new IllegalArgumentException("Invalid Gradle Tooling API request");
                String root = decode(line.substring(2));
                CancellationTokenSource source = GradleConnector.newCancellationTokenSource();
                synchronized (this) {
                    if (cancellation != null) throw new IllegalStateException("A Gradle query is already running");
                    cancellation = source;
                }
                worker.submit(() -> query(root, source));
            }
        } finally {
            cancel();
            worker.shutdown();
            try {
                if (!worker.awaitTermination(Long.MAX_VALUE, TimeUnit.NANOSECONDS)) throw new IllegalStateException("Gradle worker did not close");
            } finally {
                RuntimeException failure = null;
                for (ProjectConnection connection : connections.values()) {
                    try { connection.close(); }
                    catch (RuntimeException error) { if (failure == null) failure = error; else failure.addSuppressed(error); }
                }
                if (failure != null) throw failure;
            }
        }
    }

    // 复用每个root的连接，每次获取最新通用模型；成功返回真实任务，失败返回完整异常链，不回退Wrapper。
    private void query(String root, CancellationTokenSource source) {
        String response;
        try {
            ProjectConnection connection = connections.get(root);
            if (connection == null) {
                if (!new File(root, "gradle/wrapper/gradle-wrapper.properties").isFile()) throw new IllegalArgumentException("Gradle Wrapper properties missing in " + root);
                connection = GradleConnector.newConnector().forProjectDirectory(new File(root)).useBuildDistribution().connect();
                connections.put(root, connection);
            }
            GradleProject model = connection.model(GradleProject.class)
                    .withCancellationToken(source.token())
                    .setStandardOutput(System.err).setStandardError(System.err).get();
            TreeSet<String> tasks = new TreeSet<>();
            collect(model, tasks);
            response = "S\t" + encode(root) + "\t" + encode(String.join("\n", tasks));
        } catch (Throwable error) {
            StringBuilder detail = new StringBuilder();
            for (Throwable cause = error; cause != null; cause = cause.getCause()) {
                if (detail.length() > 0) detail.append("\nCaused by: ");
                detail.append(cause.getClass().getSimpleName()).append(": ").append(cause.getMessage());
            }
            response = "E\t" + encode(detail.toString());
        }
        synchronized (this) {
            cancellation = null;
            output.println(response);
            output.flush();
        }
    }

    // 取消当前模型操作但保留服务所有权；下一次查询必须等待当前响应完成。
    private synchronized void cancel() { if (cancellation != null) cancellation.cancel(); }

    // 只读取Gradle通用任务路径，递归保留模块身份；不访问AGP类或推测未注册任务。
    private static void collect(GradleProject project, TreeSet<String> tasks) {
        for (GradleTask task : project.getTasks()) tasks.add(task.getPath());
        for (GradleProject child : project.getChildren()) collect(child, tasks);
    }

    private static String encode(String value) { return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8)); }
    private static String decode(String value) { return new String(Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8); }
}
