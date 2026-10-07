// Test-only LD_PRELOAD interposer for the disposable debug app. Never packaged by
// a normal build. One armed fault, only on the fixed RKStorage file family.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static const char *armed = "/data/user/0/com.bitpay.wallet/files/rk-test-arm";
static const char *fired = "/data/user/0/com.bitpay.wallet/files/rk-test-fired";
static int inject(int fd, char operation) {
  int control = open(armed, O_RDONLY | O_CLOEXEC);
  if (control < 0) return 0;
  char mode = 0;
  ssize_t count = read(control, &mode, 1);
  close(control);
  if (count != 1 || mode != operation) return 0;
  char proc[64], target[512];
  snprintf(proc, sizeof(proc), "/proc/self/fd/%d", fd);
  ssize_t n = readlink(proc, target, sizeof(target) - 1);
  if (n < 0) return 0;
  target[n] = 0;
  const char *name = strrchr(target, '/');
  if (!name) return 0;
  name++;
  const char *kind = !strcmp(name, "RKStorage") ? "main" :
      !strcmp(name, "RKStorage-wal") ? "wal" :
      !strcmp(name, "RKStorage-journal") ? "journal" : NULL;
  if (!kind || unlink(armed) != 0) return 0;
  int result = open(fired, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (result >= 0) { write(result, kind, strlen(kind)); close(result); }
  errno = EIO;
  return 1;
}
int fsync(int fd) {
  if (inject(fd, 's')) return -1;
  return ((int (*)(int))dlsym(RTLD_NEXT,"fsync"))(fd);
}
int fdatasync(int fd) {
  if (inject(fd, 's')) return -1;
  return ((int (*)(int))dlsym(RTLD_NEXT,"fdatasync"))(fd);
}
ssize_t write(int fd, const void *data, size_t size) {
  if (inject(fd, 'w')) return -1;
  return ((ssize_t (*)(int,const void *,size_t))dlsym(RTLD_NEXT,"write"))(fd,data,size);
}
ssize_t pwrite(int fd, const void *data, size_t size, off_t offset) {
  if (inject(fd, 'w')) return -1;
  return ((ssize_t (*)(int,const void *,size_t,off_t))dlsym(RTLD_NEXT,"pwrite"))(fd,data,size,offset);
}
ssize_t pwrite64(int fd, const void *data, size_t size, off64_t offset) {
  if (inject(fd, 'w')) return -1;
  return ((ssize_t (*)(int,const void *,size_t,off64_t))dlsym(RTLD_NEXT,"pwrite64"))(fd,data,size,offset);
}
int ftruncate(int fd, off_t length) {
  if (length == 0 && inject(fd, 't')) return -1;
  return ((int (*)(int,off_t))dlsym(RTLD_NEXT,"ftruncate"))(fd,length);
}
int ftruncate64(int fd, off64_t length) {
  if (length == 0 && inject(fd, 't')) return -1;
  return ((int (*)(int,off64_t))dlsym(RTLD_NEXT,"ftruncate64"))(fd,length);
}
