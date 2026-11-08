// egctl: tiny helper for the ioctls Node cannot issue itself.
//
//   egctl xu get  <videodev> <unit> <selector> <len>     -> hex bytes (GET_CUR)
//   egctl xu min|max|def|res <videodev> <unit> <selector> <len>
//   egctl xu len  <videodev> <unit> <selector>           -> decimal (GET_LEN)
//   egctl xu set  <videodev> <unit> <selector> <hex>     (SET_CUR)
//   egctl hid write   <hidraw> <hex>                     (output report, first byte = report id)
//   egctl hid input   <hidraw> <reportid> <len>          -> hex (HIDIOCGINPUT)
//   egctl hid feature-get <hidraw> <reportid> <len>      -> hex (HIDIOCGFEATURE)
//   egctl hid feature-set <hidraw> <hex>                 (HIDIOCSFEATURE)
//   egctl hid info    <hidraw>                           -> "bustype vid pid"
//
// Exit status 0 on success; errors go to stderr as "error: <op>: <strerror>".

#include <errno.h>
#include <fcntl.h>
#include <linux/hidraw.h>
#include <linux/usb/video.h>
#include <linux/uvcvideo.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define MAX_BUF 4096

static int fail(const char *op) {
    fprintf(stderr, "error: %s: %s\n", op, strerror(errno));
    return 1;
}

static int usage(void) {
    fprintf(stderr, "usage: egctl xu {get|min|max|def|res|len|set} ... | egctl hid {write|input|feature-get|feature-set|info} ...\n");
    return 2;
}

static long num(const char *s) { return strtol(s, NULL, 0); }

static int parse_hex(const char *s, uint8_t *out, int max) {
    int n = 0;
    while (*s && n < max) {
        while (*s == ' ' || *s == ':' || *s == ',') s++;
        if (!s[0] || !s[1]) break;
        char b[3] = { s[0], s[1], 0 };
        out[n++] = (uint8_t)strtoul(b, NULL, 16);
        s += 2;
    }
    return n;
}

static void print_hex(const uint8_t *b, int n) {
    for (int i = 0; i < n; i++) printf("%02x", b[i]);
    printf("\n");
}

static int xu_query(int fd, int unit, int sel, int query, uint8_t *data, int size) {
    struct uvc_xu_control_query q = {
        .unit = (uint8_t)unit, .selector = (uint8_t)sel, .query = (uint8_t)query,
        .size = (uint16_t)size, .data = data,
    };
    return ioctl(fd, UVCIOC_CTRL_QUERY, &q);
}

static int cmd_xu(int argc, char **argv) {
    if (argc < 5) return usage();
    const char *op = argv[0];
    int fd = open(argv[1], O_RDWR);
    if (fd < 0) return fail("open");
    int unit = (int)num(argv[2]), sel = (int)num(argv[3]);
    uint8_t buf[MAX_BUF] = { 0 };

    if (!strcmp(op, "len")) {
        uint8_t len[2] = { 0 };
        if (xu_query(fd, unit, sel, UVC_GET_LEN, len, 2) < 0) return fail("GET_LEN");
        printf("%d\n", len[0] | (len[1] << 8));
        return 0;
    }
    if (!strcmp(op, "set")) {
        int n = parse_hex(argv[4], buf, MAX_BUF);
        if (xu_query(fd, unit, sel, UVC_SET_CUR, buf, n) < 0) return fail("SET_CUR");
        return 0;
    }
    int query = !strcmp(op, "get") ? UVC_GET_CUR : !strcmp(op, "min") ? UVC_GET_MIN
              : !strcmp(op, "max") ? UVC_GET_MAX : !strcmp(op, "def") ? UVC_GET_DEF
              : !strcmp(op, "res") ? UVC_GET_RES : -1;
    if (query < 0) return usage();
    int len = (int)num(argv[4]);
    if (len <= 0 || len > MAX_BUF) return usage();
    if (xu_query(fd, unit, sel, query, buf, len) < 0) return fail("GET");
    print_hex(buf, len);
    return 0;
}

static int cmd_hid(int argc, char **argv) {
    if (argc < 2) return usage();
    const char *op = argv[0];
    int fd = open(argv[1], O_RDWR);
    if (fd < 0) return fail("open");
    uint8_t buf[MAX_BUF] = { 0 };

    if (!strcmp(op, "info")) {
        struct hidraw_devinfo info;
        if (ioctl(fd, HIDIOCGRAWINFO, &info) < 0) return fail("HIDIOCGRAWINFO");
        printf("%u %04x %04x\n", info.bustype, (uint16_t)info.vendor, (uint16_t)info.product);
        return 0;
    }
    if (!strcmp(op, "write") || !strcmp(op, "feature-set")) {
        if (argc < 3) return usage();
        int n = parse_hex(argv[2], buf, MAX_BUF);
        if (!strcmp(op, "write")) {
            if (write(fd, buf, n) != n) return fail("write");
        } else if (ioctl(fd, HIDIOCSFEATURE(n), buf) < 0) {
            return fail("HIDIOCSFEATURE");
        }
        return 0;
    }
    if (argc < 4) return usage();
    int len = (int)num(argv[3]);
    if (len <= 0 || len > MAX_BUF) return usage();
    buf[0] = (uint8_t)num(argv[2]);
    int r;
    if (!strcmp(op, "input")) {
#ifdef HIDIOCGINPUT
        r = ioctl(fd, HIDIOCGINPUT(len), buf);
        if (r < 0) return fail("HIDIOCGINPUT");
#else
        errno = ENOSYS;
        return fail("HIDIOCGINPUT (kernel headers too old)");
#endif
    } else if (!strcmp(op, "feature-get")) {
        r = ioctl(fd, HIDIOCGFEATURE(len), buf);
        if (r < 0) return fail("HIDIOCGFEATURE");
    } else {
        return usage();
    }
    print_hex(buf, r);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 3) return usage();
    if (!strcmp(argv[1], "xu")) return cmd_xu(argc - 2, argv + 2);
    if (!strcmp(argv[1], "hid")) return cmd_hid(argc - 2, argv + 2);
    return usage();
}
