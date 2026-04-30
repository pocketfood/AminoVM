# Guest VPN Boot Persistence

This keeps the current working network model across boots:

- Windows `localhost:3002` -> QEMU guest `3000` -> VPN target `10.8.0.14:3000`
- Windows `localhost:9090` -> QEMU guest `9090` -> Cockpit in the Debian guest
- Windows `localhost:8080` / `localhost:9092` -> QEMU guest `9092` -> future VPN proxy target

The QEMU side is already bundled in `config.json`. The remaining persistence is inside the Debian guest.

## What The Password Prompt Means

If Cockpit or the terminal asks for a password while you run `sudo`, that is the Debian machine password for the current user. It is not the VPN password.

That prompt is expected only when you make system-wide changes such as:

- editing NetworkManager system connections
- enabling systemd services
- adding persistent routes

After the one-time setup below is applied successfully, normal boots should not require you to type `sudo` or manually reconnect the VPN.

## Rollback To Last Known-Good Manual Networking

If the guest gets stuck with `Wired` endlessly connecting or the VPN autostart breaks base networking, remove the boot-time VPN hook and restore plain manual NetworkManager behavior:

```bash
sudo systemctl disable --now amino-vpn-connect.service 2>/dev/null || true
sudo nmcli connection modify "Wired connection 1" connection.secondaries ""
sudo nmcli connection modify "calcium-office" ipv4.routes ""
sudo nmcli connection down "calcium-office" || true
sudo nmcli connection down "Wired connection 1" || true
sudo systemctl restart NetworkManager
sleep 5
sudo nmcli connection up "Wired connection 1"
nmcli -f DEVICE,TYPE,STATE,CONNECTION device status
nmcli -f NAME,TYPE,DEVICE con show --active
```

That returns the guest to the previous manual model:

- Ethernet comes up normally
- VPN is connected manually from the menu when needed
- local proxy services can still be enabled independently

## One-Time Setup

Paste this once inside Debian:

```bash
VPN_NAME='calcium-office'
BASE_NAME='Wired connection 1'
VPN_UUID="$(nmcli -g connection.uuid connection show "$VPN_NAME")"
sudo nmcli connection modify "$VPN_NAME" connection.permissions "" vpn.persistent yes
sudo nmcli connection modify "$BASE_NAME" connection.autoconnect yes connection.secondaries "$VPN_UUID"
sudo nmcli connection modify "$VPN_NAME" +ipv4.routes "10.8.0.0/24 10.8.0.21"
sudo systemctl enable NetworkManager-wait-online.service
sudo systemctl enable amino-gitea-proxy-3000.service
sudo nmcli connection down "$VPN_NAME" || true
sudo nmcli connection down "$BASE_NAME" || true
sudo nmcli connection up "$BASE_NAME"
nmcli -f NAME,TYPE,DEVICE con show --active
ip route get 10.8.0.14
```

## Make The VPN Auto-Start With Ethernet

Official NetworkManager behavior: VPN profiles do not autoconnect by themselves; the base connection must reference the VPN through `connection.secondaries`.

Assumes:

- VPN profile name: `calcium-office`
- Base connection name: `Wired connection 1`

Paste inside Debian:

```bash
VPN_NAME='calcium-office'; BASE_NAME='Wired connection 1'; VPN_UUID="$(nmcli -g connection.uuid connection show "$VPN_NAME")"; sudo nmcli connection modify "$VPN_NAME" connection.permissions "" vpn.persistent yes; sudo nmcli connection modify "$BASE_NAME" connection.autoconnect yes connection.secondaries "$VPN_UUID"; sudo systemctl enable NetworkManager-wait-online.service; nmcli -f connection.id,connection.uuid,connection.permissions,vpn.persistent connection show "$VPN_NAME"; nmcli -f connection.id,connection.autoconnect,connection.secondaries connection show "$BASE_NAME"
```

## Persist The VPN Route For The Remote Subnet

If the remote VPN hosts live on `10.8.0.0/24`, add an explicit route on the VPN profile so traffic keeps going through `tun0` after boot.

Paste inside Debian:

```bash
sudo nmcli connection modify calcium-office +ipv4.routes "10.8.0.0/24 10.8.0.21"
sudo nmcli connection down calcium-office || true
sudo nmcli connection down "Wired connection 1" || true
sudo nmcli connection up "Wired connection 1"
ip route get 10.8.0.14
```

If you want to keep it narrower, use only the known Gitea host:

```bash
sudo nmcli connection modify calcium-office +ipv4.routes "10.8.0.14/32 10.8.0.21"
```

## Fallback If `connection.secondaries` Fails

If `nmcli connection up "Wired connection 1"` reports `A secondary connection of the base connection failed`, stop using `connection.secondaries` for this VPN and bring it up with a root-owned systemd unit instead.

Clear the secondary reference:

```bash
sudo nmcli connection modify "Wired connection 1" connection.secondaries ""
```

Test that the VPN can be brought up directly:

```bash
sudo nmcli connection up "calcium-office" ifname ens3
```

If that works, make it persistent at boot:

```bash
printf '%s\n' '[Unit]' 'Description=Bring up calcium-office VPN after NetworkManager is online' 'After=NetworkManager.service NetworkManager-wait-online.service' 'Wants=NetworkManager-wait-online.service' '' '[Service]' 'Type=oneshot' 'ExecStart=/usr/bin/nmcli connection up "calcium-office" ifname ens3' 'RemainAfterExit=yes' '' '[Install]' 'WantedBy=multi-user.target' | sudo tee /etc/systemd/system/amino-vpn-connect.service >/dev/null && sudo systemctl daemon-reload && sudo systemctl enable amino-vpn-connect.service && sudo systemctl start amino-vpn-connect.service && nmcli -f NAME,TYPE,DEVICE con show --active && ip route get 10.8.0.14
```

This is a pragmatic fallback: NetworkManager still manages the VPN, but systemd triggers the initial connection as root at boot.

## Keep The Gitea Proxy On Every Boot

The local proxy is already designed for boot persistence. Ensure it stays enabled:

```bash
sudo systemctl enable amino-gitea-proxy-3000.service && sudo systemctl status amino-gitea-proxy-3000.service --no-pager -l
```

## If Boot Still Prompts For VPN Credentials

That means the VPN secret is not stored in the system connection profile.

First inspect the current profile:

```bash
sudo nmcli --show-secrets connection show calcium-office | sed -n '/^connection\./p;/^vpn\./p'
```

If you still see agent-owned or not-saved secret flags, store the password in the system profile. The NetworkManager keyfile format stores VPN data under `[vpn]` and VPN secrets under `[vpn-secrets]`.

Find the keyfile:

```bash
sudo grep -Ril '^id=calcium-office$' /etc/NetworkManager/system-connections
```

Then edit it as root so it contains:

```ini
[vpn]
password-flags=0

[vpn-secrets]
password=YOUR_VPN_PASSWORD
```

After editing:

```bash
sudo chmod 600 /etc/NetworkManager/system-connections/*
sudo nmcli connection reload
sudo nmcli connection down calcium-office || true
sudo nmcli connection up "Wired connection 1"
```

## Verify After Reboot

Paste inside Debian:

```bash
nmcli -f NAME,TYPE,DEVICE con show --active; ip route get 10.8.0.14; systemctl is-active amino-gitea-proxy-3000.service; curl -sv --max-time 10 http://10.8.0.14:3000/ -o /tmp/gitea-direct.out 2>&1 | sed -n '1,40p'; curl -sv --max-time 10 http://127.0.0.1:3000/ -o /tmp/gitea-local.out 2>&1 | sed -n '1,40p'
```

If those pass, Windows `http://localhost:3002/` should work immediately after launching the VM.

## Sources

- NetworkManager `connection.secondaries`, `connection.permissions`, `vpn.persistent`, `vpn.secrets`, and `vpn` autoconnect behavior:
  https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/nm-settings-nmcli.html
- `nmcli` command behavior:
  https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/nmcli.html
- NetworkManager keyfile storage and `[vpn-secrets]` format:
  https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/nm-settings-keyfile.html
