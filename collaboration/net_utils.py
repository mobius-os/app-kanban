"""Resolve peer HTTPS URLs and pin only globally routable addresses.

Keep address policy local to Kanban's outbound boundary. No platform or web
framework import is needed in the per-request service process.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

class UnsafePeerAddress(ValueError):
  """A peer URL cannot be used from the privileged service network."""

# Never route peer traffic to loopback, private networks or cloud metadata.
_BLOCKED_NETS = [
  ipaddress.ip_network("0.0.0.0/8"),
  ipaddress.ip_network("10.0.0.0/8"),
  ipaddress.ip_network("100.64.0.0/10"),     # CGNAT
  ipaddress.ip_network("127.0.0.0/8"),
  ipaddress.ip_network("169.254.0.0/16"),    # link-local + cloud metadata
  ipaddress.ip_network("172.16.0.0/12"),
  ipaddress.ip_network("192.168.0.0/16"),
  ipaddress.ip_network("::1/128"),
  ipaddress.ip_network("fc00::/7"),          # ULA
  ipaddress.ip_network("fe80::/10"),         # link-local IPv6
  # NAT64 well-known prefix — a resolver can hand back 64:ff9b::<v4> for a
  # blocked IPv4 (e.g. 64:ff9b::a9fe:a9fe == 169.254.169.254), which the
  # ipv4_mapped check below does NOT catch (that only handles ::ffff:). The
  # peer transport cannot establish the embedded destination here, so
  # block the whole prefix.
  ipaddress.ip_network("64:ff9b::/96"),
]


def validate_url_safe(url: str) -> tuple[str, str, str]:
  """Return (pinned URL, original Host header, TLS server name).

  Validate every DNS answer, then connect to exactly one validated address.
  Re-resolving at connect time would reintroduce DNS rebinding.
  """
  parsed = urlparse(url)
  if parsed.scheme != "https":
    raise UnsafePeerAddress(
      f"Peer URL scheme must be https, got {parsed.scheme!r}",
    )
  # Reject embedded credentials: board credentials belong in POST bodies. Userinfo would
  # be silently dropped when we rebuild the netloc around the pinned IP (httpx
  # otherwise turns it into a Basic-auth header), so a credentialed URL is both
  # a red flag and a footgun. Block it outright.
  if parsed.username or parsed.password:
    raise UnsafePeerAddress(
      "URL must not contain credentials (user:pass@) — peer credentials belong in the request body.",
    )
  host = parsed.hostname
  if not host:
    raise UnsafePeerAddress(f"URL is missing a hostname: {url}")
  try:
    infos = socket.getaddrinfo(host, None)
  except socket.gaierror as exc:
    raise UnsafePeerAddress(f"Cannot resolve host {host!r}: {exc}") from exc
  pinned_ip = None
  for info in infos:
    ip_str = info[4][0]
    try:
      ip = ipaddress.ip_address(ip_str)
    except ValueError:
      continue
    # An IPv6 that EMBEDS an IPv4 reaches that v4 host but won't match the
    # IPv4 entries in _BLOCKED_NETS: ::ffff:a.b.c.d (mapped, e.g.
    # ::ffff:169.254.169.254) and ::a.b.c.d (IPv4-compatible / ::/96, e.g. a
    # literal [::127.0.0.1] URL). Pull the embedded v4 and check it too.
    # (Well-known NAT64 64:ff9b::/96 is blocked as a whole prefix above.)
    candidates = [ip]
    if ip.version == 6:
      if ip.ipv4_mapped is not None:
        candidates.append(ip.ipv4_mapped)
      elif ip in ipaddress.ip_network("::/96"):
        candidates.append(ipaddress.ip_address(int(ip) & 0xFFFFFFFF))
    for cand in candidates:
      # "Public URL" means every address is globally routable, not merely
      # absent from today's private-network shortlist. Benchmark, reserved,
      # multicast, documentation, and future special-use ranges can all be
      # routed inside a deployment and therefore remain SSRF targets.
      if not cand.is_global or cand.is_multicast:
        raise UnsafePeerAddress(
          f"URL {host!r} resolves to non-public address {ip}.",
        )
      for net in _BLOCKED_NETS:
        if cand in net:
          raise UnsafePeerAddress(
            f"URL {host!r} resolves to blocked address {ip} "
            f"(network {net}).",
          )
    # Every resolved address is validated (we raise on the first blocked one),
    # so pinning to the first is safe — the fetched IP can't be an unvalidated
    # one.
    if pinned_ip is None:
      pinned_ip = ip_str
  if pinned_ip is None:
    raise UnsafePeerAddress(f"Cannot resolve host {host!r} to any address.")
  ip_host = f"[{pinned_ip}]" if ":" in pinned_ip else pinned_ip
  netloc = f"{ip_host}:{parsed.port}" if parsed.port else ip_host
  pinned_url = parsed._replace(netloc=netloc).geturl()
  # Host header carries the ORIGINAL authority (host + non-default port, IPv6
  # brackets preserved) per RFC 7230 §5.4; the SNI/cert name is the bare DNS
  # host. userinfo was rejected above, so parsed.netloc is exactly host[:port].
  return pinned_url, parsed.netloc, host
