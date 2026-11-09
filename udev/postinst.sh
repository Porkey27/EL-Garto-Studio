#!/bin/sh
# Installs the udev rule shipped in resources and reloads udev.
set -e
RULE_SRC="/opt/El-Garto Studio/resources/udev/60-el-garto-studio.rules"
if [ -f "$RULE_SRC" ]; then
  rm -f /etc/udev/rules.d/60-elgato-studio.rules /etc/udev/rules.d/60-el-gato-studio.rules  # name used before the app was renamed
  install -m 0644 "$RULE_SRC" /etc/udev/rules.d/60-el-garto-studio.rules
  udevadm control --reload-rules || true
  udevadm trigger --subsystem-match=hidraw --subsystem-match=video4linux || true
fi
