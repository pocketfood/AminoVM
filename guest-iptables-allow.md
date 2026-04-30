# Guest iptables allow-list

Generated from `config.json` host forwards.

## Port mapping

| Windows host | Guest service |
| --- | --- |
| `127.0.0.1:443/tcp` | `443/tcp` |
| `127.0.0.1:9090/tcp` | `9090/tcp` |
| `127.0.0.1:8080/tcp` | `9092/tcp` |
| `127.0.0.1:9092/tcp` | `9092/tcp` |
| `127.0.0.1:3002/tcp` | `3000/tcp` |
| `127.0.0.1:2222/tcp` | `22/tcp` |

QEMU user networking usually reaches the guest from `10.0.2.2`, so the rule below allows only that source.

## One-line paste command inside Debian

```bash
sudo mkdir -p /opt/amino /etc/iptables && printf '%s\n' '#!/bin/sh' 'iptables -C INPUT -i lo -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -i lo -j ACCEPT' 'iptables -C INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || iptables -I INPUT 2 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT' 'iptables -C INPUT -p tcp -s 10.0.2.2 -m multiport --dports 22,443,3000,9090,9092 -j ACCEPT 2>/dev/null || iptables -I INPUT 3 -p tcp -s 10.0.2.2 -m multiport --dports 22,443,3000,9090,9092 -j ACCEPT' | sudo tee /opt/amino/allow-host-forwards.sh >/dev/null && sudo chmod +x /opt/amino/allow-host-forwards.sh && sudo /opt/amino/allow-host-forwards.sh && sudo iptables-save | sudo tee /etc/iptables/rules.v4 >/dev/null
```

This applies the rules immediately, writes the reusable script to `/opt/amino/allow-host-forwards.sh`, and saves the current IPv4 rules to `/etc/iptables/rules.v4` for reference or persistence if `iptables-persistent`/`netfilter-persistent` is installed.

## Troubleshoot a forwarded port

If a Windows URL such as `http://localhost:3002` connects but shows an empty page, QEMU is reaching the guest but the service behind the mapped guest port is not returning a valid HTTP response.

Paste this inside Debian to inspect the old `3000` mapping:

```bash
echo '=== listening on 3000 ==='; sudo ss -lntp '( sport = :3000 )' || true; echo '=== local http test ==='; curl -sv --max-time 8 http://127.0.0.1:3000/ -o /tmp/amino-port-3000.out 2>&1 | sed -n '1,80p'; echo '=== guest-ip http test ==='; ip="$(hostname -I | awk '{print $1}')"; curl -sv --max-time 8 "http://${ip}:3000/" -o /tmp/amino-port-3000-guest-ip.out 2>&1 | sed -n '1,80p'; echo '=== likely service processes ==='; ps -eo pid,comm,args | grep -Ei 'node|npm|python|gunicorn|uvicorn|nginx|apache|caddy|traefik|proxy|3000' | grep -v grep || true; echo '=== firewall rules ==='; sudo iptables -S INPUT | grep -E '3000|9092|9090|443|22|10\.0\.2\.2' || true
```

If `127.0.0.1:3000` works but the guest IP test fails, restart the app so it listens on `0.0.0.0:3000` instead of only `127.0.0.1:3000`.

If both tests say `Connection refused`, the firewall is not the problem. Nothing is listening on guest port `3000`. If the real app lives on another machine over the VPN, keep `127.0.0.1:3002 -> guest:3000` in QEMU and run a Debian-local proxy on guest port `3000` that forwards to the VPN target.

Paste this inside Debian to see the common forwarded ports and Apache bindings:

```bash
echo '=== forwarded-port listeners ==='; sudo ss -lntp | awk 'NR==1 || /:(22|80|443|3000|9090|9092)\b/'; echo '=== apache virtual hosts ==='; sudo apache2ctl -S 2>&1 | sed -n '1,120p'; echo '=== quick local http checks ==='; curl -kI --max-time 5 http://127.0.0.1/ 2>&1 | sed -n '1,20p'; curl -kI --max-time 5 https://127.0.0.1/ 2>&1 | sed -n '1,20p'; curl -kI --max-time 5 http://127.0.0.1:3000/ 2>&1 | sed -n '1,20p'; curl -kI --max-time 5 http://127.0.0.1:9092/ 2>&1 | sed -n '1,20p'
```

For VPN-provided software on guest port `9092`, verify that something is listening after the VPN is connected:

```bash
echo '=== vpn/network interfaces ==='; ip -br addr; echo '=== routes ==='; ip route; echo '=== listeners for 8080/9092 ==='; sudo ss -lntp | awk 'NR==1 || /:(8080|9092)\b/'; echo '=== local 9092 tcp/http checks ==='; timeout 5 bash -lc '</dev/tcp/127.0.0.1/9092' && echo 'tcp 127.0.0.1:9092 open' || echo 'tcp 127.0.0.1:9092 closed'; curl -sv --max-time 8 http://127.0.0.1:9092/ -o /tmp/amino-9092.out 2>&1 | sed -n '1,80p'; echo '=== likely vpn/proxy processes ==='; ps -eo pid,comm,args | grep -Ei 'openvpn|wireguard|wg-|tailscale|zerotier|proxy|9092|8080|node|python|java|nginx|apache' | grep -v grep || true
```
