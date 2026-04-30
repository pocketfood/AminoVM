# Guest VPN proxy

QEMU host forwards can only target ports listening inside the Debian guest. They cannot directly target a remote service that is reachable only after Debian connects to the VPN.

For the current config:

| Windows host | Debian guest | Expected backend |
| --- | --- | --- |
| `127.0.0.1:8080/tcp` | `9092/tcp` | VPN service |
| `127.0.0.1:9092/tcp` | `9092/tcp` | VPN service |
| `127.0.0.1:3002/tcp` | `3000/tcp` | `10.8.0.14:3000` Gitea |

Debian must run a local proxy on `0.0.0.0:3000` or `0.0.0.0:9092` that forwards to the real VPN endpoint.

## Routing requirement

The Debian guest must also route the VPN target through `tun0`. If `ip route get 10.8.0.14` shows `via 10.0.2.2 dev ens3`, the traffic is not using the VPN and the local proxy will only hang or fail.

Temporary test route for the known Gitea host:

```bash
sudo ip route replace 10.8.0.14/32 via 10.8.0.21 dev tun0 && ip route get 10.8.0.14
```

Persistent NetworkManager route on the `calcium-office` VPN connection:

```bash
sudo nmcli connection modify calcium-office +ipv4.routes "10.8.0.14/32 10.8.0.21" && sudo nmcli connection down calcium-office && sudo nmcli connection up calcium-office
```

If the whole remote subnet should go over the VPN, use a wider route instead:

```bash
sudo nmcli connection modify calcium-office +ipv4.routes "10.8.0.0/24 10.8.0.21" && sudo nmcli connection down calcium-office && sudo nmcli connection up calcium-office
```

## Create local Gitea proxy for `10.8.0.14:3000`

This makes `http://localhost:3002/` on Windows flow to Debian guest port `3000`, then across the VPN to `http://10.8.0.14:3000/`.

```bash
sudo apt-get update && sudo apt-get install -y socat && printf '%s\n' '[Unit]' 'Description=Amino local proxy to VPN Gitea 3000' 'After=network-online.target NetworkManager.service' 'Wants=network-online.target' '' '[Service]' 'Restart=always' 'RestartSec=3' 'ExecStart=/usr/bin/socat TCP-LISTEN:3000,bind=0.0.0.0,fork,reuseaddr TCP:10.8.0.14:3000' '' '[Install]' 'WantedBy=multi-user.target' | sudo tee /etc/systemd/system/amino-gitea-proxy-3000.service >/dev/null && sudo systemctl daemon-reload && sudo systemctl enable --now amino-gitea-proxy-3000.service && sudo systemctl status amino-gitea-proxy-3000.service --no-pager -l
```

Test locally in Debian:

```bash
curl -sv --max-time 8 http://127.0.0.1:3000/ -o /tmp/amino-local-gitea-3000.out 2>&1 | sed -n '1,80p'
```

## Guacamole target

The Guacamole endpoint is still not identified. `10.8.0.1:9092` and `10.8.0.21:9092` were tested and are not valid targets.

Once the real VPN target is known, create the local proxy with this pattern:

```bash
sudo apt-get update && sudo apt-get install -y socat && printf '%s\n' '[Unit]' 'Description=Amino local proxy to VPN Guacamole' 'After=network-online.target NetworkManager.service' 'Wants=network-online.target' '' '[Service]' 'Restart=always' 'RestartSec=3' 'ExecStart=/usr/bin/socat TCP-LISTEN:9092,bind=0.0.0.0,fork,reuseaddr TCP:REAL_VPN_IP:REAL_VPN_PORT' '' '[Install]' 'WantedBy=multi-user.target' | sudo tee /etc/systemd/system/amino-guacamole-proxy-9092.service >/dev/null && sudo systemctl daemon-reload && sudo systemctl enable --now amino-guacamole-proxy-9092.service && sudo systemctl status amino-guacamole-proxy-9092.service --no-pager -l
```

Then test locally in Debian:

```bash
curl -skv --max-time 8 https://127.0.0.1:9092/ -o /tmp/amino-local-proxy-9092.out 2>&1 | sed -n '1,80p'
```

After QEMU is fully restarted, test from Windows:

```text
https://localhost:8080
https://localhost:9092
```
