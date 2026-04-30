# AminoVM

A simple Node.js-based launcher for a preconfigured QEMU virtual machine. VPN routing is handled by your host VPN client or network setup.

> ⚠️ This project does **not include QEMU binaries** due to licensing. See the **QEMU Setup** section below for instructions on installing them manually.

---

## Features
- Launches a QEMU VM from a preconfigured disk image
- Optional ISO boot for OS installs
- Config-driven VM settings (CPU, RAM, display, accel)
- Designed to run alongside a host VPN (routing handled externally)

---

## Requirements
- Windows Hypervisor Platform or Hyper-V enabled (for WHPX acceleration)
- Node.js (v18+ recommended for development/build)
- QEMU binaries in `qemu/`
- VM disk image (e.g., `.qcow2`)
- Optional ISO image for installs
- `pkg` for building the Windows EXE
- Optional VPN client (OpenVPN or WireGuard) if you want host VPN routing

## File structure
When exporting and distributing, the directory must have:
1. `deb.img` (or your VM disk image)
2. `qemu/`
3. `config.json`
4. ISO file specified by `config.json` (for installs)

---

## Config
The launcher reads `config.json` and uses these keys:
- `showConsole`: Show QEMU output window.
- `useIso`: `true` to boot from ISO for installs.
- `isoPath`: Path to the installer ISO.
- `diskPath`: Path to the VM disk image.
- `memoryMB`: RAM in MB.
- `cpus`: vCPU count.
- `diskFormat`: Disk format, default `qcow2`.
- `compatMode`: `true` to use legacy devices (IDE disk, RTL8139 NIC, standard VGA). Helpful if WHPX has MSI/virtio issues.
- `videoDevice`: Explicit QEMU video device. Set this to `virtio-vga` to avoid falling back to Bochs/standard VGA while keeping other compatibility settings unchanged.
- `machine`: QEMU machine type, default `pc` (i440fx).
- `display`: Display backend, default `sdl` (often smoother than `gtk` on Windows).
- `accel`: Acceleration backend, default `whpx`. You can add options like `whpx,kernel-irqchip=off` if WHPX MSI injection fails.
- `cpu`: CPU model, default `max` (WHPX does not accept `host`).
- `hostForwards`: Array of explicit QEMU `hostfwd` rules. Bind these to `127.0.0.1` if the service should stay local to the Windows host. On the default QEMU user network, omit `guestAddress` and let QEMU target the default guest automatically.
- `vnc`: Optional local-only VNC console settings. `127.0.0.1:1` maps to TCP port `5901`.
- `tray`: Optional Windows tray settings. When `enabled` is `true`, `amino launch` starts QEMU headless, hides the taskbar window, and keeps control in a native tray icon.

Paths in `config.json` can be relative to the project root or absolute.

---

## Installation

### QEMU Setup
This project depends on QEMU to launch virtual machines. Due to licensing terms (GPLv2), QEMU binaries are not included in this repository.

#### Option 1: Install QEMU manually
Download QEMU for Windows from:
- https://qemu.weilnetz.de/
- https://www.qemu.org/download/

Extract the `.exe` and `.dll` files into the `qemu/` directory at the root of this project.

---

## Debian Netinst ISO (Optional)
If you need a minimal Debian installation image, download the official Debian netinst ISO:
- https://www.debian.org/distrib/netinst

Place the `.iso` file wherever you keep VM assets and set `isoPath` in `config.json` to match.

Example:
```text
vm-images/
├── debian-13.3.0-amd64-netinst.iso
├── debian.qcow2
```

---

## CLI

The main AminoVM command surface is:

```bash
amino launch [--headless] [--tray] [--window]
amino stop
amino status

amino ports list
amino ports add --host 127.0.0.1 --hport 8080 --gport 9092
amino ports remove --host 127.0.0.1 --hport 8080

amino disk resize --path deb.img --size 80G
amino image list
amino image select --path deb.img
amino image install --path some.iso

amino build windows
amino build linux
amino build macos
```

On Windows, `--tray` now launches QEMU headless and keeps the VM in a native tray icon. Use `--window` to force the normal QEMU window even when `tray.enabled` is set in `config.json`.

---

## Usage

Install dependencies:
```bash
npm install
```

Install a distro (recommended flow):
1. Set `useIso` to `true` in `config.json` and point `isoPath` to the ISO.
2. Run:
```bash
node index.js launch
```
3. After installation, set `useIso` back to `false` to boot from disk.

Legacy install script (uses hardcoded paths):
```bash
node install.js
```

Run/test an existing image:
```bash
node index.js launch
```

When you add forwards on the default slirp network, leave `guestAddress` unset unless you intentionally changed the guest IP.

Example local-only forwards for a browser/reverse-proxy workflow:
```json
"hostForwards": [
  { "protocol": "tcp", "hostAddress": "127.0.0.1", "hostPort": 443, "guestPort": 443 },
  { "protocol": "tcp", "hostAddress": "127.0.0.1", "hostPort": 9090, "guestPort": 9090 },
  { "protocol": "tcp", "hostAddress": "127.0.0.1", "hostPort": 2222, "guestPort": 22 }
],
"videoDevice": "virtio-vga",
"vnc": { "enabled": true, "address": "127.0.0.1", "display": 1 },
"tray": { "enabled": true, "tooltip": "AminoVM", "cockpitUrl": "https://127.0.0.1:9090" }
```

---

## Guest Cleanup

If the Debian guest still tries to start an old OpenVPN unit you no longer use, run this inside the guest:

```bash
sudo systemctl disable --now openvpn-client@work.service; sudo rm -f /etc/systemd/system/multi-user.target.wants/openvpn-client@work.service; sudo systemctl reset-failed openvpn-client@work.service
```

That removes the stale boot dependency and clears the failed state from Cockpit.

---

## Expanding Disk Space

Your VM disk capacity is defined by the image file (`deb.img`). If the guest is running out of space, do this:

1. Stop the VM completely.
2. Check current image size:
```bash
npm run disk:info
```
3. Increase image capacity (example: add 20 GiB):
```bash
npm run disk:grow -- --add 20G
```
4. Alternative (set exact total size):
```bash
npm run disk:grow -- --size 40G
```

Notes:
- `disk:grow` creates a backup in `imgbackup/` by default.
- Use `--no-backup` only if you already have a backup and want a faster run.
- This only grows the image container. You must expand the partition/filesystem inside Debian.

### Inside Debian After Host Resize

Install tools:
```bash
sudo apt-get update
sudo apt-get install -y cloud-guest-utils
```

Identify your root disk and partition layout:
```bash
lsblk -o NAME,SIZE,FSTYPE,TYPE,MOUNTPOINT
findmnt -no SOURCE,FSTYPE /
```

Common cases:

1. Non-LVM root partition (ext4), e.g. `/dev/sda1` or `/dev/vda1`:
```bash
sudo growpart /dev/sda 1
sudo resize2fs /dev/sda1
```
If your disk is virtio (`compatMode: false`), use `/dev/vda` + partition number instead.

2. LVM root (common Debian guided install):
```bash
sudo growpart /dev/sda 3
sudo pvresize /dev/sda3
sudo lvextend -l +100%FREE "$(findmnt -no SOURCE /)"
sudo resize2fs "$(findmnt -no SOURCE /)"
```
If your root filesystem is XFS instead of ext4, use:
```bash
sudo xfs_growfs /
```

Verify free space:
```bash
df -h /
```

---

## Building

Old:
```bash
npm build = pkg . --targets node14-win-x64 --output aminovm.exe --debug
npx pkg . --targets node14-win-x64 --output aminovm.exe --debug --win-console=false
```

New:
```bash
npm run build
npm run build:linux
npm run build:macos
```
