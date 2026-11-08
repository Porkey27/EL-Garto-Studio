#!/bin/sh
# Installs the udev rule shipped in resources and reloads udev.
set -e
RULE_SRC="/opt/Studio for Elgato/resources/udev/60-elgato-studio.rules"
if [ -f "$RULE_SRC" ]; then
  install -m 0644 "$RULE_SRC" /etc/udev/rules.d/60-elgato-studio.rules
  udevadm control --reload-rules || true
  udevadm trigger --subsystem-match=hidraw --subsystem-match=video4linux || true
fi
