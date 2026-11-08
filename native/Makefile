CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -std=c11

build/egctl: egctl.c
	mkdir -p build
	$(CC) $(CFLAGS) -o $@ $<

clean:
	rm -rf build

.PHONY: clean
