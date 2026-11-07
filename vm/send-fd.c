// send-fd HEX: sends the bytes over fd 0 with fd 3 attached, which Node cannot do.
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/uio.h>

static int hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// Node made the socket non-blocking, and the child shares that setting.
static int wait_writable(void) {
  struct pollfd pfd = {.fd = 0, .events = POLLOUT};
  while (poll(&pfd, 1, 5000) < 0) {
    if (errno != EINTR) return -1;
  }
  return 0;
}

static int should_retry(void) {
  if (errno == EINTR) return 1;
  if (errno == EAGAIN || errno == EWOULDBLOCK) return wait_writable() == 0;
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: send-fd HEX\n");
    return 2;
  }
  size_t hex_len = strlen(argv[1]);
  if (hex_len == 0 || hex_len % 2 != 0) {
    fprintf(stderr, "send-fd: the bytes must be in hex\n");
    return 2;
  }
  size_t len = hex_len / 2;
  unsigned char *bytes = malloc(len);
  if (!bytes) {
    perror("send-fd");
    return 1;
  }
  for (size_t i = 0; i < len; i++) {
    int high = hex_digit(argv[1][2 * i]);
    int low = hex_digit(argv[1][2 * i + 1]);
    if (high < 0 || low < 0) {
      fprintf(stderr, "send-fd: the bytes must be in hex\n");
      return 2;
    }
    bytes[i] = (unsigned char)(high << 4 | low);
  }

  int fd = 3;
  union {
    struct cmsghdr align;
    char buf[CMSG_SPACE(sizeof(int))];
  } control;
  memset(&control, 0, sizeof control);
  struct iovec iov = {.iov_base = bytes, .iov_len = len};
  struct msghdr msg = {0};
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  msg.msg_control = control.buf;
  msg.msg_controllen = sizeof control.buf;
  struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
  cmsg->cmsg_level = SOL_SOCKET;
  cmsg->cmsg_type = SCM_RIGHTS;
  cmsg->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(cmsg), &fd, sizeof fd);

  ssize_t sent;
  while ((sent = sendmsg(0, &msg, 0)) < 0) {
    if (!should_retry()) {
      perror("send-fd: sendmsg");
      return 1;
    }
  }
  // The fd went with the first part; the rest needs none.
  size_t done = (size_t)sent;
  while (done < len) {
    ssize_t n = send(0, bytes + done, len - done, 0);
    if (n < 0) {
      if (!should_retry()) {
        perror("send-fd: send");
        return 1;
      }
      continue;
    }
    done += (size_t)n;
  }
  return 0;
}
