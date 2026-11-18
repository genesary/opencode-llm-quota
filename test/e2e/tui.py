# Runs a command in a 160x40 pseudo-terminal, types keys at given times, then
# writes the raw output (<out>.raw) and the final screen rendered by pyte (<out>.screen).
# Usage: tui.py <seconds> <out> [<at>:<keys>...] -- <command> [args...]
import fcntl, os, pty, select, signal, struct, sys, termios, time

import pyte

seconds, out = float(sys.argv[1]), sys.argv[2]
split = sys.argv.index("--")
keys = sorted((float(k.split(":", 1)[0]), k.split(":", 1)[1]) for k in sys.argv[3:split])
command = sys.argv[split + 1 :]

pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))

raw = b""
start = time.time()
while time.time() - start < seconds:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            raw += os.read(fd, 65536)
        except OSError:
            break
    while keys and keys[0][0] <= time.time() - start:
        text = keys.pop(0)[1].encode().decode("unicode_escape")
        os.write(fd, text.encode())
os.kill(pid, signal.SIGKILL)

screen = pyte.Screen(160, 40)
pyte.ByteStream(screen).feed(raw)
with open(out + ".raw", "w") as f:
    f.write(raw.decode("utf-8", "replace"))
with open(out + ".screen", "w") as f:
    f.write("\n".join(line.rstrip() for line in screen.display))
