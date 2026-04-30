# Stable State

This is the current known-good state. Do not change it unless there is a specific reason.

## Host / QEMU behavior

- Build artifact: `aminovm.exe`
- Console window visible
- QEMU GTK window with tabs visible
- QEMU window close button does not shut down the VM
- Video device: `std`
- Display: `gtk,window-close=off,gl=off,grab-on-hover=on,show-tabs=on`
- CPU count: `4`
- Memory: `8192 MB`
- Acceleration: `tcg`
- CPU model: `qemu64`

## Host forwards

- `https://localhost:9090` -> guest `9090` for Cockpit
- `http://localhost:3002` -> guest `3000` for VPN-backed Gitea proxy
- `https://localhost:8080` -> guest `9092` reserved for VPN-backed software
- `https://localhost:9092` -> guest `9092` reserved for VPN-backed software
- `localhost:2222` -> guest `22`

## Guest networking behavior

- `Wired connection 1` should come up normally on boot
- `office.ovpn` VPN should stay OFF by default
- Turn `office.ovpn` ON manually only when remote subnet access is needed
- `http://localhost:3002` works only while the VPN is connected
- `https://localhost:9090` works without the VPN

## Guest services

- Keep `amino-gitea-proxy-3000.service` enabled
- Keep `amino-vpn-connect.service` disabled
- Do not attach the VPN to `connection.secondaries`

## Last known-good rollback result

The guest is healthy when:

- `ens3` is connected on `Wired connection 1`
- `lo` is connected
- `office.ovpn` is not active until manually enabled

## Rule

Freeze this state.
