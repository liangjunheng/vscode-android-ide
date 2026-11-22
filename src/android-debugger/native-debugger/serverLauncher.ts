import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'teen_process';

const source = `#include <sys/inotify.h>
#include <sys/signalfd.h>
#include <sys/wait.h>
#include <sys/poll.h>
#include <signal.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

int main(int argc, char **argv) {
  if (argc != 5) return 2;
  int notifications = inotify_init1(IN_CLOEXEC);
  if (notifications < 0 || inotify_add_watch(notifications, argv[2], IN_MOVED_TO | IN_CLOSE_WRITE) < 0) { perror("inotify"); return 3; }
  sigset_t signals;
  sigemptyset(&signals);
  sigaddset(&signals, SIGCHLD); sigaddset(&signals, SIGTERM); sigaddset(&signals, SIGINT); sigaddset(&signals, SIGHUP);
  if (sigprocmask(SIG_BLOCK, &signals, NULL)) { perror("sigprocmask"); return 4; }
  int signal_fd = signalfd(-1, &signals, SFD_CLOEXEC);
  if (signal_fd < 0) { perror("signalfd"); return 5; }
  pid_t child = fork();
  if (child < 0) { perror("fork"); return 6; }
  if (child == 0) {
    sigprocmask(SIG_UNBLOCK, &signals, NULL);
    execl(argv[1], argv[1], "platform", "--listen", argv[3], "--socket-file", argv[4], (char *)NULL);
    perror("exec lldb-server"); _exit(7);
  }
  struct pollfd fds[2] = {{notifications, POLLIN, 0}, {signal_fd, POLLIN, 0}};
  const char *filename = strrchr(argv[4], '/');
  filename = filename ? filename + 1 : argv[4];
  int ready = 0;
  for (;;) {
    if (poll(fds, 2, -1) < 0) { if (errno == EINTR) continue; perror("poll"); kill(child, SIGTERM); break; }
    if (fds[1].revents & POLLIN) {
      struct signalfd_siginfo event;
      if (read(signal_fd, &event, sizeof(event)) != sizeof(event)) { perror("read signal"); kill(child, SIGTERM); break; }
      if (event.ssi_signo == SIGCHLD) {
        int status;
        if (waitpid(child, &status, WNOHANG) == child) return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      } else kill(child, event.ssi_signo);
    }
    if (!ready && (fds[0].revents & POLLIN)) {
      char events[4096] __attribute__((aligned(__alignof__(struct inotify_event))));
      ssize_t length = read(notifications, events, sizeof(events));
      if (length < 0) { perror("read inotify"); kill(child, SIGTERM); break; }
      for (char *cursor = events; cursor < events + length;) {
        struct inotify_event *event = (struct inotify_event *)cursor;
        if (event->len && !strcmp(event->name, filename) && (event->mask & (IN_MOVED_TO | IN_CLOSE_WRITE))) {
          FILE *file = fopen(argv[4], "r");
          char socket[256] = {0};
          if (!file || !fgets(socket, sizeof(socket), file)) { perror("read socket id"); if (file) fclose(file); kill(child, SIGTERM); goto finished; }
          fclose(file);
          if (strcmp(socket, argv[3] + strlen("unix-abstract://"))) { fprintf(stderr, "Unexpected socket identity\\n"); kill(child, SIGTERM); goto finished; }
          printf("ANDROID_NATIVE_LISTENING\\t%s\\n", socket); fflush(stdout); ready = 1; fds[0].fd = -1;
        }
        cursor += sizeof(*event) + event->len;
      }
    }
  }
finished:
  while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
  return 8;
}
`;

/** 功能：用当前NDK编译设备事件启动器；输入已验证NDK和ABI；输出临时可执行文件及精确清理；验证：native-server-launcher.test.js与同PID真机入口。 */
export async function compileServerLauncher(ndkRoot: string, abi: string): Promise<{ file: string; close(): Promise<void> }> {
  const targets: Record<string, string> = { 'armeabi': 'armv7a-linux-androideabi23', 'armeabi-v7a': 'armv7a-linux-androideabi23', 'arm64-v8a': 'aarch64-linux-android23', 'x86': 'i686-linux-android23', 'x86_64': 'x86_64-linux-android23' };
  const target = targets[abi];
  if (!target) throw new Error('Unsupported Native launcher ABI: ' + abi);
  const host = process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
  const toolchain = path.join(ndkRoot, 'toolchains', 'llvm', 'prebuilt', host);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'android-native-launcher-'));
  const file = path.join(directory, 'server-launcher');
  const close = () => fs.rm(directory, { recursive: true });
  try {
    const input = path.join(directory, 'launcher.c');
    await fs.writeFile(input, source);
    await exec(path.join(toolchain, 'bin', process.platform === 'win32' ? 'clang.exe' : 'clang'), ['--target=' + target, '--sysroot=' + path.join(toolchain, 'sysroot'), '-O2', '-Wall', '-Werror', input, '-o', file]);
    return { file, close };
  } catch (error) { await close(); throw error; }
}
